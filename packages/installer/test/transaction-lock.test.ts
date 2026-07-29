import { type ChildProcess, fork } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  InstallerFileSystemError,
  type InstallerTransactionFileSystem,
} from "../src/file-system.js";
import { InstallerError } from "../src/installer-error.js";
import {
  acquireInstallerLocks,
  type InstallerLockDependencies,
} from "../src/installer-lock.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const statePath = "/home/tester/.local/state/ai-engine/installer.json";
const configPath = "/home/tester/.config/codex/config.toml";
const otherConfigPath = "/home/tester/.config/hermes/config.yaml";
const stateLockPath = `${statePath}.lock`;
const configLockPath = `${configPath}.ai-engine-installer.lock`;
const otherConfigLockPath = `${otherConfigPath}.ai-engine-installer.lock`;

interface LockIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface LockRecord extends LockIdentity {
  bytes: Uint8Array;
  mode: number;
}

interface CreateExclusiveRequest {
  readonly mode: number;
  readonly path: string;
}

interface LockFileSystemFixture {
  readonly fileSystem: InstallerTransactionFileSystem;
  readonly locks: Map<string, LockRecord>;
  readonly createCalls: CreateExclusiveRequest[];
  readonly handleCalls: string[];
  readonly removeCalls: string[];
  readonly createFailures: Map<string, unknown>;
  readonly removeFailures: Map<string, unknown>;
  replace(path: string, metadata: Readonly<Record<string, unknown>>): void;
}

function alreadyExists(): InstallerFileSystemError {
  return new InstallerFileSystemError("ALREADY_EXISTS");
}

function ioFailure(): InstallerFileSystemError {
  return new InstallerFileSystemError(
    "IO_FAILED",
    new Error("fixture I/O failure"),
  );
}

function createLockFileSystem(): LockFileSystemFixture {
  let nextInode = 10n;
  const locks = new Map<string, LockRecord>();
  const createCalls: CreateExclusiveRequest[] = [];
  const handleCalls: string[] = [];
  const removeCalls: string[] = [];
  const createFailures = new Map<string, unknown>();
  const removeFailures = new Map<string, unknown>();

  function handle(path: string, record: LockRecord) {
    return {
      chmod: vi.fn(async (mode: number) => {
        handleCalls.push(`chmod:${path}:${mode.toString(8)}`);
        record.mode = mode;
      }),
      chown: vi.fn(async () => {
        handleCalls.push(`chown:${path}`);
      }),
      close: vi.fn(async () => {
        handleCalls.push(`close:${path}`);
      }),
      readAll: vi.fn(async (maximumBytes: number) => {
        handleCalls.push(`read:${path}:${maximumBytes}`);
        if (record.bytes.byteLength > maximumBytes) throw ioFailure();
        return Uint8Array.from(record.bytes);
      }),
      stat: vi.fn(async () => {
        handleCalls.push(`stat:${path}`);
        return {
          kind: "regular-file" as const,
          uid: 1_000,
          gid: 1_000,
          mode: record.mode,
          dev: record.dev,
          ino: record.ino,
        };
      }),
      sync: vi.fn(async () => {
        handleCalls.push(`sync:${path}`);
      }),
      writeAll: vi.fn(async (bytes: Uint8Array) => {
        handleCalls.push(`write:${path}`);
        record.bytes = Uint8Array.from(bytes);
      }),
    };
  }

  const fileSystem = {
    createExclusiveNoFollow: vi.fn(async (path: string, mode: number) => {
      createCalls.push({ path, mode });
      const failure = createFailures.get(path);
      if (failure !== undefined) throw failure;
      if (locks.has(path)) throw alreadyExists();
      const record = {
        bytes: new Uint8Array(),
        mode,
        dev: 7n,
        ino: nextInode++,
      };
      locks.set(path, record);
      return handle(path, record);
    }),
    inspectPathNoFollow: vi.fn(async (path: string) => {
      const record = locks.get(path);
      return record === undefined
        ? { kind: "missing" as const }
        : {
            kind: "regular-file" as const,
            uid: 1_000,
            gid: 1_000,
            mode: record.mode,
            dev: record.dev,
            ino: record.ino,
          };
    }),
    openReadNoFollow: vi.fn(async (path: string) => {
      const record = locks.get(path);
      if (record === undefined) {
        throw new InstallerFileSystemError("NOT_FOUND");
      }
      return handle(path, record);
    }),
    unlink: vi.fn(async (path: string) => {
      removeCalls.push(path);
      const failure = removeFailures.get(path);
      if (failure !== undefined) throw failure;
      locks.delete(path);
    }),
  };

  return {
    fileSystem: fileSystem as unknown as InstallerTransactionFileSystem,
    locks,
    createCalls,
    handleCalls,
    removeCalls,
    createFailures,
    removeFailures,
    replace: (path, metadata) => {
      locks.set(path, {
        bytes: encoder.encode(JSON.stringify(metadata)),
        mode: 0o600,
        dev: 7n,
        ino: nextInode++,
      });
    },
  };
}

function createFakeClock() {
  let monotonicMilliseconds = 0;
  const epochMilliseconds = Date.parse("2026-07-28T12:00:00.000Z");
  return {
    clock: {
      monotonicNow: vi.fn(() => monotonicMilliseconds),
      now: vi.fn(() => epochMilliseconds + monotonicMilliseconds),
      wait: vi.fn(async (milliseconds: number) => {
        monotonicMilliseconds += milliseconds;
      }),
    },
    elapsed: () => monotonicMilliseconds,
  };
}

function dependencies(
  fixture: LockFileSystemFixture,
  overrides: Partial<InstallerLockDependencies> = {},
) {
  const fakeClock = createFakeClock();
  const entropy = [
    Uint8Array.from([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb,
      0xcc, 0xdd, 0xee, 0xff,
    ]),
    Uint8Array.from([
      0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44,
      0x33, 0x22, 0x11, 0x00,
    ]),
  ];
  const randomBytes = vi.fn((length: number) => {
    expect(length).toBe(16);
    const value = entropy.shift();
    if (value === undefined) throw new Error("Unexpected entropy request.");
    return value;
  });
  return {
    fakeClock,
    randomBytes,
    value: {
      clock: fakeClock.clock,
      fileSystem: fixture.fileSystem,
      processId: 4242,
      randomBytes,
      ...overrides,
    } as InstallerLockDependencies,
  };
}

function parseLock(record: LockRecord | undefined): Record<string, unknown> {
  if (record === undefined) throw new Error("Expected lock metadata.");
  return JSON.parse(decoder.decode(record.bytes)) as Record<string, unknown>;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof InstallerError ? error.code : undefined;
}

interface LockProcessAudit {
  readonly commandAttempts: readonly string[];
  readonly commandGuards: readonly string[];
  readonly networkAttempts: readonly string[];
  readonly networkGuards: readonly string[];
}

interface LockProcessMessage {
  readonly type: string;
  readonly audit: LockProcessAudit;
  readonly code?: string;
  readonly elapsedMilliseconds?: number;
  readonly paths?: readonly string[];
}

interface RunningLockProcess {
  readonly child: ChildProcess;
  readonly stderr: () => string;
}

interface PosixSnapshot {
  readonly bytes: Buffer;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: number;
}

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const lockProcessFixture = fileURLToPath(
  new URL("./fixtures/transaction-lock-process.mjs", import.meta.url),
);
const lockIoSentinel = fileURLToPath(
  new URL("./fixtures/transaction-lock-io-sentinel.mjs", import.meta.url),
);

function startLockProcess(
  role: "holder" | "contender",
  processStatePath: string,
  processConfigPath: string,
): RunningLockProcess {
  const child = fork(
    lockProcessFixture,
    [role, processStatePath, processConfigPath],
    {
      cwd: repositoryRoot,
      execArgv: ["--import", lockIoSentinel],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string | Buffer) => {
    stderr += chunk.toString();
  });
  return { child, stderr: () => stderr };
}

function waitForLockMessage(
  running: RunningLockProcess,
  timeoutMilliseconds = 5_000,
): Promise<LockProcessMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the lock fixture process."));
    }, timeoutMilliseconds);
    const cleanup = () => {
      clearTimeout(timeout);
      running.child.off("message", onMessage);
      running.child.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      cleanup();
      resolve(message as LockProcessMessage);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Lock fixture exited before reporting (code=${String(code)}, signal=${String(signal)}): ${running.stderr()}`,
        ),
      );
    };
    running.child.once("message", onMessage);
    running.child.once("exit", onExit);
  });
}

function waitForLockExit(
  running: RunningLockProcess,
  timeoutMilliseconds = 5_000,
): Promise<{ readonly code: number | null; readonly signal: string | null }> {
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    return Promise.resolve({
      code: running.child.exitCode,
      signal: running.child.signalCode,
    });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the lock fixture to exit."));
    }, timeoutMilliseconds);
    const cleanup = () => {
      clearTimeout(timeout);
      running.child.off("exit", onExit);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    running.child.once("exit", onExit);
  });
}

function sendHolderRelease(running: RunningLockProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!running.child.connected) {
      reject(new Error("The holder IPC channel is closed."));
      return;
    }
    running.child.send({ type: "release" }, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

async function stopLockProcess(
  running: RunningLockProcess | undefined,
): Promise<void> {
  if (
    running === undefined ||
    running.child.exitCode !== null ||
    running.child.signalCode !== null
  ) {
    return;
  }
  if (running.child.connected) {
    try {
      await sendHolderRelease(running);
      await waitForLockExit(running, 1_000);
      return;
    } catch {
      // A failed fixture must not be allowed to retain a test lock indefinitely.
    }
  }
  running.child.kill("SIGTERM");
  await waitForLockExit(running, 1_000).catch(() => undefined);
}

function snapshot(path: string): PosixSnapshot {
  const status = lstatSync(path, { bigint: true });
  return {
    bytes: readFileSync(path),
    dev: status.dev,
    ino: status.ino,
    mode: Number(status.mode & 0o7777n),
  };
}

function expectNoExternalIo(message: LockProcessMessage): void {
  expect(message.audit.commandAttempts).toEqual([]);
  expect(message.audit.networkAttempts).toEqual([]);
  expect(message.audit.commandGuards).toEqual(
    expect.arrayContaining([
      "child_process.exec",
      "child_process.execFile",
      "child_process.fork",
      "child_process.spawn",
    ]),
  );
  expect(message.audit.networkGuards).toEqual(
    expect.arrayContaining([
      "global.fetch",
      "global.WebSocket",
      "http.request",
      "https.request",
      "net.connect",
      "tls.connect",
      "dns.lookup",
    ]),
  );
}

describe("AE-INSTALL-AC-15 installer locks", () => {
  it("creates the exact state-then-config locks privately with closed metadata", async () => {
    const fixture = createLockFileSystem();
    const { value, randomBytes } = dependencies(fixture);

    const owned = await acquireInstallerLocks({
      configPath,
      dependencies: value,
      statePath,
    });

    expect(fixture.createCalls.map(({ path }) => path)).toEqual([
      stateLockPath,
      configLockPath,
    ]);
    for (const call of fixture.createCalls) {
      expect(call.mode).toBe(0o600);
    }
    expect(randomBytes).toHaveBeenNthCalledWith(1, 16);
    expect(randomBytes).toHaveBeenNthCalledWith(2, 16);
    expect(parseLock(fixture.locks.get(stateLockPath))).toEqual({
      pid: 4242,
      createdAt: "2026-07-28T12:00:00.000Z",
      targetPath: statePath,
      ownershipToken: "00112233445566778899aabbccddeeff",
    });
    expect(parseLock(fixture.locks.get(configLockPath))).toEqual({
      pid: 4242,
      createdAt: "2026-07-28T12:00:00.000Z",
      targetPath: configPath,
      ownershipToken: "ffeeddccbbaa99887766554433221100",
    });
    expect(
      Object.keys(parseLock(fixture.locks.get(configLockPath))).sort(),
    ).toEqual(["createdAt", "ownershipToken", "pid", "targetPath"]);

    await owned.release();
    expect(fixture.removeCalls).toEqual([configLockPath, stateLockPath]);
    expect(fixture.locks).toEqual(new Map());
    const descriptorFileSystem = fixture.fileSystem as unknown as {
      readonly openReadNoFollow: ReturnType<typeof vi.fn>;
    };
    expect(descriptorFileSystem.openReadNoFollow).toHaveBeenCalledTimes(2);
    expect(descriptorFileSystem.openReadNoFollow).toHaveBeenNthCalledWith(
      1,
      configLockPath,
    );
    expect(descriptorFileSystem.openReadNoFollow).toHaveBeenNthCalledWith(
      2,
      stateLockPath,
    );
    const boundedReads = fixture.handleCalls
      .filter((call) => call.startsWith("read:"))
      .map((call) => Number(call.slice(call.lastIndexOf(":") + 1)));
    expect(boundedReads).toHaveLength(2);
    expect(
      boundedReads.every((maximum) => maximum > 0 && maximum <= 4_096),
    ).toBe(true);
  });

  it.each([
    [stateLockPath, "STATE_LOCKED"],
    [configLockPath, "CONFIG_LOCKED"],
  ])(
    "waits at most the fake-clock two-second total budget for %s",
    async (occupiedPath, expectedCode) => {
      const fixture = createLockFileSystem();
      fixture.replace(occupiedPath, {
        pid: 999,
        createdAt: "2026-07-28T11:00:00.000Z",
        targetPath: occupiedPath === stateLockPath ? statePath : configPath,
        ownershipToken: "f".repeat(32),
      });
      const original = Uint8Array.from(
        fixture.locks.get(occupiedPath)?.bytes ?? [],
      );
      const { value, fakeClock } = dependencies(fixture);

      await expect(
        acquireInstallerLocks({ configPath, dependencies: value, statePath }),
      ).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === expectedCode,
      );

      expect(fakeClock.elapsed()).toBe(2_000);
      expect(fixture.locks.get(occupiedPath)?.bytes).toEqual(original);
      expect(fixture.removeCalls.includes(occupiedPath)).toBe(false);
      if (occupiedPath === configLockPath) {
        expect(fixture.locks.has(stateLockPath)).toBe(false);
      }
    },
  );

  it("serializes writers that target different configs through the one state lock", async () => {
    const fixture = createLockFileSystem();
    const first = dependencies(fixture);
    const firstOwned = await acquireInstallerLocks({
      configPath,
      dependencies: first.value,
      statePath,
    });
    const second = dependencies(fixture);

    await expect(
      acquireInstallerLocks({
        configPath: otherConfigPath,
        dependencies: second.value,
        statePath,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "STATE_LOCKED",
    );
    expect(second.fakeClock.elapsed()).toBe(2_000);
    expect(
      fixture.createCalls.some(({ path }) => path === otherConfigLockPath),
    ).toBe(false);
    expect(fixture.locks.has(stateLockPath)).toBe(true);

    await firstOwned.release();
  });

  it("lets cancellation observed at the timeout boundary win over LOCKED", async () => {
    const fixture = createLockFileSystem();
    fixture.replace(stateLockPath, {
      pid: 999,
      createdAt: "2026-07-28T11:00:00.000Z",
      targetPath: statePath,
      ownershipToken: "f".repeat(32),
    });
    const controller = new AbortController();
    const fakeClock = createFakeClock();
    fakeClock.clock.wait.mockImplementation(async (milliseconds: number) => {
      await Promise.resolve();
      const originalNow = fakeClock.clock.monotonicNow.getMockImplementation();
      const previous = originalNow?.() ?? 0;
      fakeClock.clock.monotonicNow.mockReturnValue(previous + milliseconds);
      if (previous + milliseconds >= 2_000) controller.abort();
    });
    const value = {
      clock: fakeClock.clock,
      fileSystem: fixture.fileSystem,
      processId: 4242,
      randomBytes: () => new Uint8Array(16),
      signal: controller.signal,
    } as InstallerLockDependencies;

    await expect(
      acquireInstallerLocks({ configPath, dependencies: value, statePath }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "CANCELLED");
  });

  it.each([
    [stateLockPath, "STATE_WRITE_FAILED"],
    [configLockPath, "CONFIG_WRITE_FAILED"],
  ])(
    "maps non-EEXIST lock creation failure at %s without leaking its cause",
    async (failurePath, expectedCode) => {
      const fixture = createLockFileSystem();
      fixture.createFailures.set(failurePath, ioFailure());
      const { value } = dependencies(fixture);

      await expect(
        acquireInstallerLocks({ configPath, dependencies: value, statePath }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(errorCode(error)).toBe(expectedCode);
        expect(JSON.stringify(error)).not.toContain("fixture I/O failure");
        return true;
      });
      if (failurePath === configLockPath) {
        expect(fixture.locks.has(stateLockPath)).toBe(false);
      }
    },
  );

  it.each(["identity", "ownership token"])(
    "never removes a replaced lock with a different %s",
    async (change) => {
      const fixture = createLockFileSystem();
      const { value } = dependencies(fixture);
      const owned = await acquireInstallerLocks({
        configPath,
        dependencies: value,
        statePath,
      });
      const current = parseLock(fixture.locks.get(configLockPath));
      if (change === "identity") {
        fixture.replace(configLockPath, current);
      } else {
        const record = fixture.locks.get(configLockPath);
        if (record === undefined) throw new Error("Expected a config lock.");
        record.bytes = encoder.encode(
          JSON.stringify({ ...current, ownershipToken: "f".repeat(32) }),
        );
      }

      await expect(owned.release()).rejects.toMatchObject({
        code: "CONFIG_LOCKED",
      });

      expect(fixture.locks.has(configLockPath)).toBe(true);
      expect(fixture.locks.has(stateLockPath)).toBe(false);
    },
  );

  it("releases idempotently in config-then-state order", async () => {
    const fixture = createLockFileSystem();
    const { value } = dependencies(fixture);
    const owned = await acquireInstallerLocks({
      configPath,
      dependencies: value,
      statePath,
    });

    await owned.release();
    await owned.release();

    expect(fixture.removeCalls).toEqual([configLockPath, stateLockPath]);
  });

  it("preserves the primary commit error when both cleanup attempts fail", async () => {
    const fixture = createLockFileSystem();
    const { value } = dependencies(fixture);
    const owned = await acquireInstallerLocks({
      configPath,
      dependencies: value,
      statePath,
    });
    fixture.removeFailures.set(configLockPath, ioFailure());
    fixture.removeFailures.set(stateLockPath, ioFailure());
    const primary = new InstallerError("CONFIG_CHANGED");

    await expect(owned.release(primary)).rejects.toBe(primary);
    expect(fixture.removeCalls).toEqual([configLockPath, stateLockPath]);
  });

  it.each([
    [true, false, "CONFIG_LOCKED"],
    [false, true, "STATE_LOCKED"],
    [true, true, "STATE_LOCKED"],
  ])(
    "maps sole cleanup failures to lock codes with state precedence (config=%s, state=%s)",
    async (configFails, stateFails, expectedCode) => {
      const fixture = createLockFileSystem();
      const { value } = dependencies(fixture);
      const owned = await acquireInstallerLocks({
        configPath,
        dependencies: value,
        statePath,
      });
      if (configFails) fixture.removeFailures.set(configLockPath, ioFailure());
      if (stateFails) fixture.removeFailures.set(stateLockPath, ioFailure());

      await expect(owned.release()).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === expectedCode,
      );
      expect(fixture.removeCalls).toEqual([configLockPath, stateLockPath]);
    },
  );

  it("serializes two real processes targeting different configs on the exact shared state lock", async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "ai-engine-two-process-lock-"),
    );
    const realStatePath = join(
      temporaryRoot,
      "state",
      "ai-engine",
      "installer.json",
    );
    const firstConfigPath = join(temporaryRoot, "configs", "a", "mcp.json");
    const secondConfigPath = join(temporaryRoot, "configs", "b", "mcp.json");
    const realStateLockPath = `${realStatePath}.lock`;
    const firstConfigLockPath = `${firstConfigPath}.ai-engine-installer.lock`;
    const secondConfigLockPath = `${secondConfigPath}.ai-engine-installer.lock`;
    const originalState = Buffer.from(
      '{"schemaVersion":1,"installations":{"holder":"retained"}}\n',
    );
    let holder: RunningLockProcess | undefined;
    let contender: RunningLockProcess | undefined;

    try {
      mkdirSync(dirname(realStatePath), { mode: 0o700, recursive: true });
      mkdirSync(dirname(firstConfigPath), { mode: 0o700, recursive: true });
      mkdirSync(dirname(secondConfigPath), { mode: 0o700, recursive: true });
      writeFileSync(realStatePath, originalState, { mode: 0o600 });
      const stateBefore = snapshot(realStatePath);

      holder = startLockProcess("holder", realStatePath, firstConfigPath);
      const acquired = await waitForLockMessage(holder);
      expect(acquired.type).toBe("acquired");
      expect(acquired.paths).toEqual([realStateLockPath, firstConfigLockPath]);
      expectNoExternalIo(acquired);

      const stateLockBefore = snapshot(realStateLockPath);
      const configLockBefore = snapshot(firstConfigLockPath);
      expect(stateLockBefore.mode).toBe(0o600);
      expect(configLockBefore.mode).toBe(0o600);
      expect(JSON.parse(stateLockBefore.bytes.toString("utf8"))).toMatchObject({
        pid: holder.child.pid,
        targetPath: realStatePath,
        ownershipToken: expect.stringMatching(/^[0-9a-f]{32}$/u),
      });

      contender = startLockProcess(
        "contender",
        realStatePath,
        secondConfigPath,
      );
      const failed = await waitForLockMessage(contender, 4_000);
      expect(failed.type).toBe("failed");
      expect(failed.code).toBe("STATE_LOCKED");
      expect(failed.elapsedMilliseconds).toBeGreaterThanOrEqual(1_900);
      expect(failed.elapsedMilliseconds).toBeLessThan(3_000);
      expectNoExternalIo(failed);
      expect(await waitForLockExit(contender)).toEqual({
        code: 0,
        signal: null,
      });
      contender = undefined;

      expect(snapshot(realStateLockPath)).toEqual(stateLockBefore);
      expect(snapshot(firstConfigLockPath)).toEqual(configLockBefore);
      expect(snapshot(realStatePath)).toEqual(stateBefore);
      expect(readFileSync(realStatePath)).toEqual(originalState);
      expect(existsSync(secondConfigLockPath)).toBe(false);

      const releasedMessage = waitForLockMessage(holder);
      await sendHolderRelease(holder);
      const released = await releasedMessage;
      expect(released.type).toBe("released");
      expectNoExternalIo(released);
      expect(await waitForLockExit(holder)).toEqual({
        code: 0,
        signal: null,
      });
      holder = undefined;

      expect(existsSync(realStateLockPath)).toBe(false);
      expect(existsSync(firstConfigLockPath)).toBe(false);
      expect(existsSync(secondConfigLockPath)).toBe(false);
      expect(snapshot(realStatePath)).toEqual(stateBefore);
    } finally {
      await stopLockProcess(contender);
      await stopLockProcess(holder);
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }, 10_000);
});
