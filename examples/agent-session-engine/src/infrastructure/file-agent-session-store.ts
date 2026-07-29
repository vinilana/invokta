import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

import type {
  AgentSessionStore,
  CreateSessionResult,
  SaveSessionResult,
  StoreOptions,
} from "../application/ports.js";
import { agentSessionSchema } from "../application/session-schema.js";
import type { AgentSession } from "../domain/agent-session.js";

const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 30_000;

export interface FileAgentSessionStoreOptions {
  readonly dataDirectory: string;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

export function createFileAgentSessionStore(
  options: FileAgentSessionStoreOptions,
): AgentSessionStore {
  const dataDirectory = resolve(options.dataDirectory);
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw new TypeError("lockTimeoutMs must be a positive integer.");
  }
  if (!Number.isInteger(staleLockMs) || staleLockMs < 1) {
    throw new TypeError("staleLockMs must be a positive integer.");
  }

  const fileStem = (sessionId: string) => encodeURIComponent(sessionId);
  const pathsFor = (sessionId: string) => ({
    state: join(dataDirectory, `${fileStem(sessionId)}.json`),
    lock: join(dataDirectory, `${fileStem(sessionId)}.lock`),
  });

  const read = async (sessionId: string): Promise<AgentSession | null> => {
    const { state } = pathsFor(sessionId);
    let encoded: string;
    try {
      encoded = await readFile(state, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded) as unknown;
    } catch (cause) {
      throw new Error("The persisted agent session is not valid JSON.", {
        cause,
      });
    }
    const result = agentSessionSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error("The persisted agent session does not match its schema.");
    }
    return result.data;
  };

  const removeStaleLock = async (lockPath: string): Promise<void> => {
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs <= staleLockMs) return;
      await unlink(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  };

  const withLock = async <Result>(
    sessionId: string,
    storeOptions: StoreOptions | undefined,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const { lock } = pathsFor(sessionId);
    const deadline = Date.now() + lockTimeoutMs;
    let acquired = false;
    while (!acquired) {
      ensureNotAborted(storeOptions?.signal);
      try {
        const handle = await open(lock, "wx", 0o600);
        try {
          await handle.writeFile(
            `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        acquired = true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        await removeStaleLock(lock);
        if (Date.now() >= deadline) {
          throw new Error(
            "Timed out while waiting for the agent session lock.",
          );
        }
        await delay(LOCK_RETRY_MS, undefined, {
          ...(storeOptions?.signal === undefined
            ? {}
            : { signal: storeOptions.signal }),
        });
      }
    }

    try {
      ensureNotAborted(storeOptions?.signal);
      return await operation();
    } finally {
      await unlink(lock).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
  };

  const write = async (session: AgentSession): Promise<void> => {
    const validated = agentSessionSchema.parse(session);
    const { state } = pathsFor(session.sessionId);
    const temporary = join(
      dataDirectory,
      `.${fileStem(session.sessionId)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    let closed = false;
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      closed = true;
      await rename(temporary, state);
    } catch (error) {
      if (!closed) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };

  return {
    async create(session, storeOptions): Promise<CreateSessionResult> {
      return withLock(session.sessionId, storeOptions, async () => {
        if ((await read(session.sessionId)) !== null) return "exists";
        await write(session);
        return "created";
      });
    },
    async findById(sessionId, storeOptions) {
      ensureNotAborted(storeOptions?.signal);
      return read(sessionId);
    },
    async save(
      session,
      expectedRevision,
      storeOptions,
    ): Promise<SaveSessionResult> {
      return withLock(session.sessionId, storeOptions, async () => {
        const current = await read(session.sessionId);
        if (current === null) return "missing";
        if (current.revision !== expectedRevision) return "conflict";
        await write(session);
        return "saved";
      });
    },
  };
}
