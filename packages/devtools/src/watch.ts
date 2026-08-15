import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, watch as watchDirectory } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ThrownValueInfo } from "./diagnostics.js";
import type { InvocationRecord } from "./engine-host.js";
import type { PrincipalStore } from "./principal-store.js";
import type { EngineView } from "./server.js";
import type { TraceStore } from "./trace-store.js";

export interface StartWatchOptions {
  readonly moduleSpecifier: string;
  readonly exportName: string;
  readonly cwd: string;
  readonly buildCommand: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly enginePort?: number;
  readonly principals: PrincipalStore;
  readonly trace: TraceStore;
  /** Paths to watch, resolved against `cwd`. Defaults to `cwd` itself. */
  readonly include?: string[];
  /**
   * Extra ignore patterns: an entry matches a whole path segment, or a
   * simple suffix glob such as `*.log`. `dist`, `.data`, and `*.log` are
   * always ignored on top of node_modules, dotfiles, and the built module.
   */
  readonly ignore?: string[];
  /** Receives non-protocol child stderr and build diagnostics. */
  readonly onDiagnostic?: (text: string) => void;
}

export interface WatchHandles {
  engineView(): EngineView;
  enginePort(): number;
  close(): Promise<void>;
}

export type StartWatchResult =
  | { readonly kind: "started"; readonly handles: WatchHandles }
  | {
      readonly kind: "load-error";
      readonly stage: "load-failed" | "export-missing" | "not-an-engine";
      readonly error?: ThrownValueInfo;
    }
  | { readonly kind: "refused"; readonly doctor: unknown };

interface ChildSnapshot {
  readonly port: number;
  readonly engine: { readonly name: string; readonly version: string };
  readonly capabilities: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly doctor: unknown;
}

type ChildStart =
  | { readonly kind: "ready"; readonly snapshot: ChildSnapshot }
  | {
      readonly kind: "load-error";
      readonly stage: "load-failed" | "export-missing" | "not-an-engine";
      readonly error?: ThrownValueInfo;
    }
  | { readonly kind: "refused"; readonly doctor: unknown }
  | { readonly kind: "exited" };

const protocolPrefix = "@invokta-devtools ";
const debounceMs = 300;
const killTimeoutMs = 3000;
const noticeDetailLineLimit = 40;

function hostEntryPath(): string {
  const sibling = fileURLToPath(new URL("./host-entry.js", import.meta.url));
  if (existsSync(sibling)) return sibling;
  // Running from TypeScript sources (tests): use the built package output.
  return fileURLToPath(new URL("../dist/host-entry.js", import.meta.url));
}

function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, killTimeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Watch mode: the engine runs in a replaceable child process. Source changes
 * run the developer's explicit build command, and only a successful build
 * replaces the child — the previous host keeps serving through a failed
 * build, and no module is ever reloaded in process.
 */
export async function startWatchMode(
  options: StartWatchOptions,
): Promise<StartWatchResult> {
  const modulePath = resolve(options.cwd, options.moduleSpecifier);
  const moduleDirectory = dirname(modulePath);
  // Build-output siblings are only ignored when the module directory is a
  // proper subdirectory of the cwd; at the cwd root that would ignore
  // everything, and outside the cwd the prefix can never match. The built
  // module file itself is always ignored, which covers both edge cases.
  const moduleDirectoryInsideCwd = (() => {
    const relativeDirectory = relative(options.cwd, moduleDirectory);
    return relativeDirectory !== "" && !relativeDirectory.startsWith("..");
  })();
  const ignorePatterns = ["dist", ".data", "*.log", ...(options.ignore ?? [])];
  const watchRoots = (
    options.include === undefined || options.include.length === 0
      ? [options.cwd]
      : options.include
  ).map((includePath) => resolve(options.cwd, includePath));

  let child: ChildProcess | undefined;
  let snapshot: ChildSnapshot | undefined;
  let closed = false;
  let cycleRunning = false;
  let dirty = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const diagnostic = (text: string): void => {
    try {
      options.onDiagnostic?.(text);
    } catch {
      // A diagnostic destination failure never affects watching.
    }
  };

  const sendPrincipals = (): void => {
    const records = options.principals
      .list()
      .map(({ token, principal }) => ({ token, principal }));
    try {
      child?.stdin?.write(
        `${JSON.stringify({ type: "principals", records })}\n`,
      );
    } catch {
      // The next child start resends the full table.
    }
  };

  const unsubscribePrincipals = options.principals.subscribe(sendPrincipals);

  const startChild = (): Promise<ChildStart> =>
    new Promise((resolvePromise) => {
      let settled = false;
      const settle = (result: ChildStart): void => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
      };

      const spawned = spawn(
        process.execPath,
        [
          hostEntryPath(),
          options.moduleSpecifier,
          options.exportName,
          options.allowedOrigins.join(","),
          String(options.enginePort ?? 0),
        ],
        { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] },
      );
      child = spawned;

      // Child stdout carries no protocol; forward it like non-protocol
      // stderr so engine logging stays visible in the terminal.
      let stdoutBuffered = "";
      spawned.stdout.setEncoding("utf8");
      spawned.stdout.on("data", (chunk: string) => {
        stdoutBuffered += chunk;
        const lines = stdoutBuffered.split("\n");
        stdoutBuffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line !== "") diagnostic(`${line}\n`);
        }
      });

      let buffered = "";
      spawned.stderr.setEncoding("utf8");
      spawned.stderr.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith(protocolPrefix)) {
            if (line !== "") diagnostic(`${line}\n`);
            continue;
          }
          let message: Readonly<Record<string, unknown>>;
          try {
            message = JSON.parse(line.slice(protocolPrefix.length)) as Readonly<
              Record<string, unknown>
            >;
          } catch {
            continue;
          }
          if (message.type === "ready") {
            snapshot = {
              port: message.port as number,
              engine: message.engine as ChildSnapshot["engine"],
              capabilities:
                message.capabilities as ChildSnapshot["capabilities"],
              doctor: message.doctor,
            };
            settle({ kind: "ready", snapshot });
            continue;
          }
          if (message.type === "record") {
            options.trace.appendInvocation(message.record as InvocationRecord);
            continue;
          }
          if (message.type === "load-error") {
            settle({
              kind: "load-error",
              stage: message.stage as "load-failed",
              ...(message.error === undefined
                ? {}
                : { error: message.error as ThrownValueInfo }),
            });
            continue;
          }
          if (message.type === "doctor-findings") {
            settle({ kind: "refused", doctor: message.doctor });
          }
        }
      });
      spawned.once("exit", () => {
        settle({ kind: "exited" });
      });
      sendPrincipals();
    });

  const runBuild = (): Promise<{
    readonly ok: boolean;
    readonly output: string;
  }> =>
    new Promise((resolvePromise) => {
      const build = spawn(options.buildCommand, [], {
        cwd: options.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      build.stdout.setEncoding("utf8");
      build.stderr.setEncoding("utf8");
      build.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      build.stderr.on("data", (chunk: string) => {
        output += chunk;
      });
      build.once("exit", (code) => {
        if (code !== 0) diagnostic(output);
        resolvePromise({ ok: code === 0, output });
      });
      build.once("error", () => {
        resolvePromise({ ok: false, output });
      });
    });

  const buildDetail = (output: string): string =>
    output.split("\n").slice(0, noticeDetailLineLimit).join("\n").trimEnd();

  const runCycle = async (): Promise<void> => {
    if (cycleRunning || closed) {
      dirty = true;
      return;
    }
    cycleRunning = true;
    do {
      dirty = false;
      diagnostic("change detected, rebuilding…\n");
      const cycleStartedAt = Date.now();
      const built = await runBuild();
      if (closed) break;
      if (!built.ok) {
        options.trace.appendNotice("build-failed", buildDetail(built.output));
        diagnostic("build failed, keeping previous engine\n");
        continue;
      }
      const previous = child;
      if (previous !== undefined) await killChild(previous);
      if (closed) break;
      const started = await startChild();
      if (started.kind === "ready") {
        const elapsed = ((Date.now() - cycleStartedAt) / 1000).toFixed(1);
        options.trace.appendNotice("engine-restarted", `${elapsed}s`);
        diagnostic(
          `rebuild ok (${elapsed}s), engine restarted on port ${String(started.snapshot.port)}\n`,
        );
      } else {
        options.trace.appendNotice("engine-start-failed");
        diagnostic(
          "invokta-devtools: the rebuilt engine could not start; waiting for the next change.\n",
        );
      }
    } while (dirty && !closed);
    cycleRunning = false;
  };

  const schedule = (): void => {
    if (closed) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void runCycle();
    }, debounceMs);
  };

  const initial = await startChild();
  if (initial.kind !== "ready") {
    closed = true;
    unsubscribePrincipals();
    if (child !== undefined) await killChild(child);
    if (initial.kind === "exited") {
      return { kind: "load-error", stage: "load-failed" };
    }
    return initial;
  }

  const handleWatchEvent =
    (root: string) =>
    (_event: string, filename: string | null): void => {
      if (filename === null) {
        schedule();
        return;
      }
      const segments = filename.split(sep);
      if (
        segments.some(
          (segment) => segment === "node_modules" || segment.startsWith("."),
        )
      ) {
        return;
      }
      if (
        ignorePatterns.some((pattern) =>
          pattern.startsWith("*")
            ? filename.endsWith(pattern.slice(1))
            : segments.includes(pattern),
        )
      ) {
        return;
      }
      const changedPath = resolve(root, filename);
      if (changedPath === modulePath) return;
      if (
        moduleDirectoryInsideCwd &&
        changedPath.startsWith(`${moduleDirectory}${sep}`)
      ) {
        return;
      }
      schedule();
    };

  const watchers = watchRoots
    .filter((root) => {
      if (existsSync(root)) return true;
      diagnostic(
        `invokta-devtools: watch path does not exist, skipping: ${root}\n`,
      );
      return false;
    })
    .map((root) =>
      watchDirectory(root, { recursive: true }, handleWatchEvent(root)),
    );

  return {
    kind: "started",
    handles: {
      engineView: () => ({
        name: snapshot?.engine.name ?? "unknown",
        version: snapshot?.engine.version ?? "unknown",
        capabilities: snapshot?.capabilities ?? [],
        doctor: snapshot?.doctor ?? {},
      }),
      enginePort: () => snapshot?.port ?? 0,
      close: async () => {
        closed = true;
        if (debounceTimer !== undefined) clearTimeout(debounceTimer);
        for (const watcher of watchers) watcher.close();
        unsubscribePrincipals();
        if (child !== undefined) await killChild(child);
      },
    },
  };
}
