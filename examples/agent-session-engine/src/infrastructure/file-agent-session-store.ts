import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { defineConnector } from "@invokta/core";
import { z } from "zod";

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

export type FileAgentSessionConnectorDependencies = Readonly<
  Record<string, never>
>;

const fileAgentSessionConnectorConfig = z.object({
  dataDirectory: z.string().refine((value) => value.trim() !== ""),
  lockTimeoutMs: z.number().int().positive().safe().optional(),
  staleLockMs: z.number().int().positive().safe().optional(),
});

interface LockRecord {
  readonly ownerId: string | null;
  readonly pid: number;
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

function parseLockRecord(encoded: string): LockRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("pid" in parsed) ||
    !Number.isSafeInteger(parsed.pid) ||
    (parsed.pid as number) < 1 ||
    (parsed.pid as number) > 2_147_483_647
  ) {
    return null;
  }
  const ownerId = "ownerId" in parsed ? parsed.ownerId : null;
  if (ownerId !== null && typeof ownerId !== "string") return null;
  return { ownerId, pid: parsed.pid as number };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

export function createFileAgentSessionStore(
  options: FileAgentSessionStoreOptions,
): AgentSessionStore {
  if (options.dataDirectory.trim() === "") {
    throw new TypeError("dataDirectory must not be empty.");
  }
  const dataDirectory = resolve(options.dataDirectory);
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw new TypeError("lockTimeoutMs must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(staleLockMs) || staleLockMs < 1) {
    throw new TypeError("staleLockMs must be a positive safe integer.");
  }

  const fileStem = (sessionId: string) =>
    createHash("sha256").update(sessionId).digest("hex");
  const pathsFor = (sessionId: string) => ({
    state: join(dataDirectory, `${fileStem(sessionId)}.json`),
    lock: join(dataDirectory, `${fileStem(sessionId)}.lock`),
  });

  const read = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<AgentSession | null> => {
    ensureNotAborted(signal);
    const { state } = pathsFor(sessionId);
    let encoded: string;
    try {
      encoded = await readFile(state, {
        encoding: "utf8",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    ensureNotAborted(signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded) as unknown;
    } catch {
      throw new Error("The persisted agent session is not valid JSON.", {
        cause: new Error("The persisted session payload could not be parsed."),
      });
    }
    const result = agentSessionSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error("The persisted agent session does not match its schema.");
    }
    return result.data;
  };

  const removeStaleLock = async (
    lockPath: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    ensureNotAborted(signal);
    try {
      const lockStat = await stat(lockPath);
      ensureNotAborted(signal);
      if (Date.now() - lockStat.mtimeMs <= staleLockMs) return;
      const encoded = await readFile(lockPath, {
        encoding: "utf8",
        ...(signal === undefined ? {} : { signal }),
      });
      ensureNotAborted(signal);
      const record = parseLockRecord(encoded);
      if (record !== null && processIsAlive(record.pid)) return;
      const confirmation = await readFile(lockPath, {
        encoding: "utf8",
        ...(signal === undefined ? {} : { signal }),
      });
      ensureNotAborted(signal);
      if (confirmation !== encoded) return;
      await unlink(lockPath);
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      if (errorCode(error) !== "ENOENT") throw error;
    }
  };

  const withLock = async <Result>(
    sessionId: string,
    storeOptions: StoreOptions | undefined,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    ensureNotAborted(storeOptions?.signal);
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    ensureNotAborted(storeOptions?.signal);
    const { lock } = pathsFor(sessionId);
    const ownerId = randomUUID();
    const lockCandidate = join(
      dataDirectory,
      `.${fileStem(sessionId)}.${ownerId}.lock-candidate`,
    );
    const deadline = Date.now() + lockTimeoutMs;
    let acquired = false;
    let candidateCreated = false;
    try {
      const candidateHandle = await open(lockCandidate, "wx", 0o600);
      candidateCreated = true;
      try {
        await candidateHandle.writeFile(
          `${JSON.stringify({ ownerId, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        );
        await candidateHandle.sync();
      } finally {
        await candidateHandle.close();
      }

      while (!acquired) {
        ensureNotAborted(storeOptions?.signal);
        try {
          await link(lockCandidate, lock);
          acquired = true;
          try {
            await unlink(lockCandidate);
            candidateCreated = false;
          } catch {
            // The owner link is complete; final cleanup retries the candidate.
          }
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          await removeStaleLock(lock, storeOptions?.signal);
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

      const release = async (): Promise<void> => {
        const record = parseLockRecord(await readFile(lock, "utf8"));
        if (record?.ownerId !== ownerId) {
          throw new Error("Agent session lock ownership was lost.");
        }
        await unlink(lock);
      };
      try {
        ensureNotAborted(storeOptions?.signal);
        const result = await operation();
        await release();
        return result;
      } catch (error) {
        await release().catch(() => undefined);
        throw error;
      }
    } finally {
      if (candidateCreated) {
        await unlink(lockCandidate).catch((error: unknown) => {
          if (errorCode(error) !== "ENOENT") throw error;
        });
      }
    }
  };

  const write = async (
    session: AgentSession,
    signal?: AbortSignal,
  ): Promise<void> => {
    ensureNotAborted(signal);
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
      ensureNotAborted(signal);
      await handle.sync();
      ensureNotAborted(signal);
      await handle.close();
      closed = true;
      ensureNotAborted(signal);
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
        if ((await read(session.sessionId, storeOptions?.signal)) !== null) {
          return "exists";
        }
        await write(session, storeOptions?.signal);
        return "created";
      });
    },
    async findById(sessionId, storeOptions) {
      ensureNotAborted(storeOptions?.signal);
      return read(sessionId, storeOptions?.signal);
    },
    async save(
      session,
      expectedRevision,
      storeOptions,
    ): Promise<SaveSessionResult> {
      return withLock(session.sessionId, storeOptions, async () => {
        const current = await read(session.sessionId, storeOptions?.signal);
        if (current === null) return "missing";
        if (current.revision !== expectedRevision) return "conflict";
        await write(session, storeOptions?.signal);
        return "saved";
      });
    },
  };
}

export const fileAgentSessionConnector = defineConnector({
  name: "file-agent-sessions",
  config: fileAgentSessionConnectorConfig,
  create(config, _dependencies: FileAgentSessionConnectorDependencies) {
    return {
      ports: {
        sessions: createFileAgentSessionStore({
          dataDirectory: config.dataDirectory,
          ...(config.lockTimeoutMs === undefined
            ? {}
            : { lockTimeoutMs: config.lockTimeoutMs }),
          ...(config.staleLockMs === undefined
            ? {}
            : { staleLockMs: config.staleLockMs }),
        }),
      },
    };
  },
});
