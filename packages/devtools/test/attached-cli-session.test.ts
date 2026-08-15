import { spawn as realSpawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTACHED_CLI_SESSION_LIMITS,
  AttachedCliSessionError,
  createAttachedCliSessionController,
} from "../src/cli-attached-session.js";

const owner = "browser-session-a";
const otherOwner = "browser-session-b";
const fixture = fileURLToPath(
  new URL("./fixtures/cli-workbench.mjs", import.meta.url),
);
const canary = "cli-env-canary-8f3c1a92";
const hostCanaryName = "INVOKTA_TEST_CLI_HOST_CANARY";
const hostCanaryValue = "host-canary-must-not-reach-child";

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly shell?: boolean;
    readonly stdio?: unknown;
  };
}

function trackedSpawn() {
  const calls: SpawnCall[] = [];
  const spawn = (
    command: string,
    args: readonly string[],
    options: SpawnCall["options"],
  ) => {
    calls.push({ command, args, options });
    return realSpawn(command, [...args], {
      ...options,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  return { spawn, calls };
}

function target(
  scenario = "ok",
  extra: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly extraArgs?: readonly string[];
  } = {},
) {
  return {
    command: process.execPath,
    args: [fixture, "--scenario", scenario, ...(extra.extraArgs ?? [])],
    ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
    ...(extra.env === undefined ? {} : { env: extra.env }),
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<AttachedCliSessionError> {
  const rejection = await promise.catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(AttachedCliSessionError);
  expect(rejection).toMatchObject({ code });
  return rejection as AttachedCliSessionError;
}

function createManualClock() {
  let now = 1_000;
  const timers = new Map<
    symbol,
    { readonly at: number; readonly callback: () => void }
  >();
  return {
    now: () => now,
    schedule(callback: () => void, delayMs: number): symbol {
      const handle = Symbol("timer");
      timers.set(handle, { at: now + delayMs, callback });
      return handle;
    },
    cancel(handle: unknown): void {
      if (typeof handle === "symbol") timers.delete(handle);
    },
    advance(ms: number): void {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(handle);
        timer.callback();
      }
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for spawn.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  delete process.env[hostCanaryName];
  vi.useRealTimers();
});

describe("createAttachedCliSessionController", () => {
  it("lists on Connect with shell: false and an exited child", async () => {
    const { spawn, calls } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    const cwd = mkdtempSync(join(tmpdir(), "invokta-cli-attach-"));
    const summary = await controller.connect(
      owner,
      target("ok", { cwd, env: { CLI_FIXTURE_TOKEN: "present" } }),
    );

    expect(summary).toMatchObject({
      validation: { status: "ok" },
      capabilityCount: 2,
    });
    expect(controller.state(owner).state).toBe("connected");
    expect(controller.catalog(owner).map(({ id }) => id)).toEqual([
      "fixture.echo",
      "fixture.ping",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.args.slice(-1)).toEqual(["list"]);
    expect(calls[0]?.args.slice(0, -1)).toEqual([fixture, "--scenario", "ok"]);
    expect(calls[0]?.options.shell).toBe(false);
    expect(calls[0]?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(calls[0]?.options.cwd).toBe(cwd);
    expect(calls[0]?.options.env?.CLI_FIXTURE_TOKEN).toBe("present");
    expect(JSON.stringify(calls[0])).not.toContain("adapter-runner");
    expect(controller.activity(owner)[0]).toMatchObject({
      operation: "list",
      outcome: "success",
      exitCode: 0,
    });
    await controller.close();
  });

  it("refreshes by spawning list again and never describe or run", async () => {
    const { spawn, calls } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await controller.connect(owner, target("ok"));
    await controller.refresh(owner);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.args.at(-1) === "list")).toBe(true);
    expect(
      calls.some(
        (call) => call.args.includes("describe") || call.args.includes("run"),
      ),
    ).toBe(false);
    expect(controller.state(owner).state).toBe("connected");
    await controller.close();
  });

  it.each([
    ["nonzero", "CONNECTION_FAILED"],
    ["not-json", "PROTOCOL_ERROR"],
    ["two-values", "PROTOCOL_ERROR"],
    ["non-array", "PROTOCOL_ERROR"],
    ["non-object-element", "PROTOCOL_ERROR"],
    ["missing-id", "PROTOCOL_ERROR"],
    ["empty-id", "PROTOCOL_ERROR"],
    ["missing-description", "PROTOCOL_ERROR"],
    ["bad-title", "PROTOCOL_ERROR"],
    ["bad-annotations", "PROTOCOL_ERROR"],
    ["oversize-catalog", "LIMIT_EXCEEDED"],
    ["oversize-stdout", "LIMIT_EXCEEDED"],
    ["oversize-stderr", "LIMIT_EXCEEDED"],
  ] as const)("fails closed on a bad catalog (%s)", async (scenario, code) => {
    const { spawn, calls } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    const failure = await expectCode(
      controller.connect(owner, target(scenario)),
      code,
    );
    expect(failure.message).not.toContain(canary);
    expect(controller.state(owner).state).toBe("idle");
    expect(controller.catalog(owner)).toEqual([]);
    expect(
      calls.some(
        (call) => call.args.includes("describe") || call.args.includes("run"),
      ),
    ).toBe(false);
    expect(JSON.stringify(controller.state(owner))).not.toContain(canary);
    await controller.close();
  });

  it("accepts an empty catalog, extra properties, pretty JSON, and duplicate ids", async () => {
    const { spawn } = trackedSpawn();
    const empty = createAttachedCliSessionController({ spawn });
    await empty.connect(owner, target("empty"));
    expect(empty.catalog(owner)).toEqual([]);
    expect(empty.state(owner).state).toBe("connected");
    await empty.close();

    const extras = createAttachedCliSessionController({ spawn });
    await extras.connect(owner, target("extra-props"));
    expect(extras.catalog(owner)).toEqual([
      { id: "fixture.echo", description: "Echoes a value." },
    ]);
    await extras.close();

    const pretty = createAttachedCliSessionController({ spawn });
    await pretty.connect(owner, target("pretty"));
    expect(pretty.catalog(owner)).toHaveLength(2);
    await pretty.close();

    const duplicates = createAttachedCliSessionController({ spawn });
    await duplicates.connect(owner, target("duplicate-ids"));
    expect(
      duplicates.catalog(owner).map(({ description }) => description),
    ).toEqual(["first", "second"]);
    await duplicates.close();

    const blank = createAttachedCliSessionController({ spawn });
    await blank.connect(owner, target("empty-description"));
    expect(blank.catalog(owner)[0]?.description).toBe("");
    await blank.close();

    const stderr = createAttachedCliSessionController({ spawn });
    await stderr.connect(owner, target("stderr-ok"));
    expect(stderr.state(owner).state).toBe("connected");
    expect(JSON.stringify(stderr.activity(owner))).not.toContain("diagnostic");
    await stderr.close();
  });

  it("accepts exact 2000 summaries and exact 10 MiB stdout", async () => {
    const { spawn } = trackedSpawn();
    const catalog = createAttachedCliSessionController({ spawn });
    await catalog.connect(owner, target("exact-2000"));
    expect(catalog.catalog(owner)).toHaveLength(2_000);
    await catalog.close();

    const stream = createAttachedCliSessionController({ spawn });
    await stream.connect(owner, target("exact-10mib"));
    expect(stream.state(owner).state).toBe("connected");
    expect(stream.catalog(owner)).toEqual([]);
    await stream.close();
  });

  it("describes a listed id without spawning run", async () => {
    const { spawn, calls } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await controller.connect(owner, target("ok"));
    const described = await controller.describe(owner, "fixture.echo");
    expect(described).toMatchObject({
      id: "fixture.echo",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args.slice(-2)).toEqual(["describe", "fixture.echo"]);
    expect(calls[1]?.options.shell).toBe(false);
    expect(calls.some((call) => call.args.includes("run"))).toBe(false);
    expect(controller.state(owner).state).toBe("connected");
    await controller.close();
  });

  it("keeps the session connected when describe fails and never spawns run", async () => {
    const { spawn, calls } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await controller.connect(owner, target("describe-fail"));
    await expectCode(
      controller.describe(owner, "fixture.echo"),
      "CONNECTION_FAILED",
    );
    expect(controller.state(owner).state).toBe("connected");
    expect(controller.catalog(owner).map(({ id }) => id)).toEqual([
      "fixture.echo",
      "fixture.ping",
    ]);
    expect(controller.description(owner)).toBeUndefined();
    expect(calls.some((call) => call.args.includes("run"))).toBe(false);
    await expectCode(
      controller.run(owner, "fixture.echo", { value: "x" }),
      "NOT_CONNECTED",
    );
    expect(calls.some((call) => call.args.includes("run"))).toBe(false);
    await controller.close();
  });

  it("keeps the session connected when describe is not JSON and never spawns run", async () => {
    const { spawn, calls } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await controller.connect(owner, target("describe-not-json"));
    await expectCode(
      controller.describe(owner, "fixture.echo"),
      "PROTOCOL_ERROR",
    );
    expect(controller.state(owner).state).toBe("connected");
    expect(controller.catalog(owner)).toHaveLength(2);
    expect(controller.description(owner)).toBeUndefined();
    expect(calls.some((call) => call.args.includes("run"))).toBe(false);
    await controller.close();
  });

  it("spawns run only after list and describe, and only on Run", async () => {
    const { spawn, calls } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await controller.connect(owner, target("run-ok"));
    await controller.refresh(owner);
    await controller.describe(owner, "fixture.echo");
    const runCallsBefore = calls.filter((call) => call.args.includes("run"));
    expect(runCallsBefore).toHaveLength(0);
    const result = await controller.run(owner, "fixture.echo", {
      value: "hello",
    });
    expect(result).toEqual({ echoed: { value: "hello" } });
    const runCall = calls.find((call) => call.args.includes("run"));
    expect(runCall?.args.slice(-4)).toEqual([
      "run",
      "fixture.echo",
      "--input",
      '{"value":"hello"}',
    ]);
    expect(runCall?.args).not.toContain("--stdin");
    expect(runCall?.args).not.toContain("--format");
    expect(runCall?.args.join(" ")).not.toMatch(/--actor|--login|--principal/);
    expect(runCall?.options.shell).toBe(false);
    await controller.close();
  });

  it("keeps the session connected after a failed run", async () => {
    const { spawn } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await controller.connect(owner, target("run-fail"));
    await controller.describe(owner, "fixture.echo");
    await expectCode(
      controller.run(owner, "fixture.echo", { value: "x" }),
      "CONNECTION_FAILED",
    );
    expect(controller.state(owner).state).toBe("connected");
    expect(controller.catalog(owner)).toHaveLength(2);
    expect(
      controller.activity(owner).some((record) => record.operation === "run"),
    ).toBe(true);
    await controller.close();
  });

  it("rejects a second Connect or in-flight verb as busy", async () => {
    const { spawn, calls } = trackedSpawn();
    const clock = createManualClock();
    const controller = createAttachedCliSessionController({
      spawn,
      clock,
      killGraceMs: 5,
    });
    const pending = controller.connect(owner, target("sleep"));
    await waitFor(() => calls.length === 1);
    await expectCode(
      controller.connect(otherOwner, target("ok")),
      "TARGET_BUSY",
    );
    await expectCode(controller.describe(owner, "fixture.echo"), "TARGET_BUSY");
    expect(controller.state(otherOwner)).toEqual({ state: "busy" });
    clock.advance(ATTACHED_CLI_SESSION_LIMITS.listTimeoutMs);
    await expectCode(pending, "TIMEOUT");
    expect(controller.state(owner).state).toBe("idle");
    await controller.close();
  });

  it("disconnects a failed Refresh and does not keep the catalog", async () => {
    const { spawn } = trackedSpawn();
    const countFile = join(
      mkdtempSync(join(tmpdir(), "invokta-cli-count-")),
      "count",
    );
    writeFileSync(countFile, "0");
    const controller = createAttachedCliSessionController({ spawn });
    await controller.connect(
      owner,
      target("list-ok-then-fail", { extraArgs: ["--count-file", countFile] }),
    );
    expect(controller.state(owner).state).toBe("connected");
    await expectCode(controller.refresh(owner), "CONNECTION_FAILED");
    expect(controller.state(owner).state).toBe("idle");
    expect(controller.catalog(owner)).toEqual([]);
    await controller.close();
  });

  it("fails closed before spawn when --input exceeds 98_304 bytes", async () => {
    const { spawn, calls } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await controller.connect(owner, target("run-ok"));
    await controller.describe(owner, "fixture.echo");
    const oversized = "x".repeat(98_305);
    await expectCode(
      controller.run(owner, "fixture.echo", { value: oversized }),
      "LIMIT_EXCEEDED",
    );
    expect(calls.some((call) => call.args.includes("run"))).toBe(false);
    expect(controller.state(owner).state).toBe("connected");
    await controller.close();
  });

  it("accepts an --input argument of exactly 98_304 UTF-8 bytes", async () => {
    const { spawn, calls } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await controller.connect(owner, target("run-ok"));
    await controller.describe(owner, "fixture.echo");
    const prefix = '{"value":"';
    const suffix = '"}';
    const exact = "x".repeat(
      ATTACHED_CLI_SESSION_LIMITS.inputArgumentBytes -
        prefix.length -
        suffix.length,
    );
    const encoded = `${prefix}${exact}${suffix}`;
    expect(Buffer.byteLength(encoded, "utf8")).toBe(
      ATTACHED_CLI_SESSION_LIMITS.inputArgumentBytes,
    );
    await expect(
      controller.run(owner, "fixture.echo", { value: exact }),
    ).resolves.toEqual({ echoed: { value: exact } });
    const runCall = calls.find((call) => call.args.includes("run"));
    expect(runCall?.args.at(-1)).toBe(encoded);
    await controller.close();
  });

  it("uses the SDK-safe default environment plus overlay and ignores stdin", async () => {
    process.env[hostCanaryName] = hostCanaryValue;
    process.env.FACADE_CANARY = "must-not-reach-child";
    const { spawn, calls } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await controller.connect(
      owner,
      target("ok", { env: { CLI_OVERLAY: canary } }),
    );
    const env = calls[0]?.options.env ?? {};
    expect(env.CLI_OVERLAY).toBe(canary);
    expect(env[hostCanaryName]).toBeUndefined();
    expect(env.FACADE_CANARY).toBeUndefined();
    expect(Object.hasOwn(env, "PATH")).toBe(true);
    expect(calls[0]?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(JSON.stringify(controller.state(owner))).not.toContain(canary);
    expect(JSON.stringify(controller.activity(owner))).not.toContain(canary);
    await controller.disconnect(owner);
    expect(controller.state(owner).state).toBe("idle");
    await controller.close();
    delete process.env.FACADE_CANARY;
  });

  it("does not echo a canary env value in activity, state, or errors", async () => {
    const { spawn } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await expectCode(
      controller.connect(owner, target("nonzero", { env: { SECRET: canary } })),
      "CONNECTION_FAILED",
    );
    const serialized = JSON.stringify({
      state: controller.state(owner),
      activity: controller.activity(owner),
    });
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("SECRET");
    await controller.close();
  });

  it("does not write files under a project directory", async () => {
    const project = mkdtempSync(join(tmpdir(), "invokta-cli-project-"));
    writeFileSync(join(project, "package.json"), "{}");
    const before = readdirSync(project);
    const { spawn } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await controller.connect(owner, target("ok", { cwd: project }));
    await controller.describe(owner, "fixture.echo");
    await controller.disconnect(owner);
    await controller.close();
    expect(readdirSync(project)).toEqual(before);
  });

  it("rejects a missing command without spawning", async () => {
    const { spawn, calls } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await expectCode(controller.connect(owner, { args: [] }), "INVALID_TARGET");
    expect(calls).toHaveLength(0);
    await controller.close();
  });

  it("rejects a second connected target as busy", async () => {
    const { spawn } = trackedSpawn();
    const controller = createAttachedCliSessionController({ spawn });
    await controller.connect(owner, target("ok"));
    await expectCode(controller.connect(owner, target("ok")), "TARGET_BUSY");
    await expectCode(
      controller.connect(otherOwner, target("ok")),
      "TARGET_BUSY",
    );
    await controller.close();
  });

  it("terminates an in-flight child on disconnect", async () => {
    const { spawn, calls } = trackedSpawn();
    const clock = createManualClock();
    const controller = createAttachedCliSessionController({
      spawn,
      clock,
      killGraceMs: 5,
    });
    const pending = controller.connect(owner, target("sleep"));
    await waitFor(() => calls.length === 1);
    await controller.disconnect(owner);
    await expectCode(pending, "NOT_CONNECTED");
    expect(controller.state(owner).state).toBe("idle");
    await controller.close();
  });
});
