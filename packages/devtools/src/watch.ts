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
  readonly allowedOrigin: string;
  readonly enginePort?: number;
  readonly principals: PrincipalStore;
  readonly trace: TraceStore;
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
  const ignore = (() => {
    const moduleDirectory = relative(
      options.cwd,
      dirname(resolve(options.cwd, options.moduleSpecifier)),
    );
    return moduleDirectory === "" || moduleDirectory.startsWith("..")
      ? undefined
      : `${moduleDirectory}${sep}`;
  })();

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
          options.allowedOrigin,
          String(options.enginePort ?? 0),
        ],
        { cwd: options.cwd, stdio: ["pipe", "ignore", "pipe"] },
      );
      child = spawned;

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

  const runBuild = (): Promise<boolean> =>
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
        resolvePromise(code === 0);
      });
      build.once("error", () => {
        resolvePromise(false);
      });
    });

  const runCycle = async (): Promise<void> => {
    if (cycleRunning || closed) {
      dirty = true;
      return;
    }
    cycleRunning = true;
    do {
      dirty = false;
      const built = await runBuild();
      if (closed) break;
      if (!built) {
        options.trace.appendNotice("build-failed");
        continue;
      }
      const previous = child;
      if (previous !== undefined) await killChild(previous);
      if (closed) break;
      const started = await startChild();
      if (started.kind === "ready") {
        options.trace.appendNotice("engine-restarted");
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

  const watcher = watchDirectory(
    options.cwd,
    { recursive: true },
    (_event, filename) => {
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
      if (ignore !== undefined && `${filename}${sep}`.startsWith(ignore)) {
        return;
      }
      schedule();
    },
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
        watcher.close();
        unsubscribePrincipals();
        if (child !== undefined) await killChild(child);
      },
    },
  };
}
