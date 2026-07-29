import {
  type InstallerFileStat,
  InstallerFileSystemError,
  type InstallerTransactionFileSystem,
  isInstallerFileSystemError,
} from "./file-system.js";
import { InstallerError } from "./installer-error.js";

/** Injected time source so the bounded lock wait stays testable on a fake clock. */
export interface InstallerLockClock {
  readonly monotonicNow: () => number;
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Promise<void>;
}

export interface InstallerLockDependencies {
  readonly clock: InstallerLockClock;
  readonly fileSystem: InstallerTransactionFileSystem;
  readonly processId: number;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly signal?: AbortSignal;
}

export interface AcquireInstallerLocksInput {
  readonly configPath: string;
  readonly dependencies: InstallerLockDependencies;
  readonly statePath: string;
}

export interface OwnedInstallerLocks {
  /** The state lock followed by the config lock, in acquisition order. */
  readonly paths: readonly string[];
  readonly release: (primaryError?: unknown) => Promise<void>;
}

type LockedCode = "STATE_LOCKED" | "CONFIG_LOCKED";
type WriteFailedCode = "STATE_WRITE_FAILED" | "CONFIG_WRITE_FAILED";

interface HeldInstallerLock {
  readonly identity: InstallerFileStat;
  readonly lockedCode: LockedCode;
  readonly lockPath: string;
  readonly ownershipToken: string;
  released: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const lockFileMode = 0o600;
const ownershipTokenBytes = 16;
const maximumLockMetadataBytes = 4_096;
const totalLockWaitMilliseconds = 2_000;
const initialLockWaitMilliseconds = 25;
const maximumLockWaitMilliseconds = 400;

export function stateLockPath(statePath: string): string {
  return `${statePath}.lock`;
}

export function configLockPath(configPath: string): string {
  return `${configPath}.ai-engine-installer.lock`;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new InstallerError("CANCELLED");
}

function encodeOwnershipToken(bytes: Uint8Array): string {
  let token = "";
  for (const byte of bytes) token += byte.toString(16).padStart(2, "0");
  return token;
}

function mintOwnershipToken(
  randomBytes: InstallerLockDependencies["randomBytes"],
  writeFailedCode: WriteFailedCode,
): string {
  const bytes = randomBytes(ownershipTokenBytes);
  if (bytes.byteLength !== ownershipTokenBytes) {
    throw new InstallerError(writeFailedCode);
  }
  return encodeOwnershipToken(bytes);
}

function serializeLockMetadata(
  processId: number,
  createdAtMilliseconds: number,
  targetPath: string,
  ownershipToken: string,
): Uint8Array {
  return encoder.encode(
    `${JSON.stringify({
      pid: processId,
      createdAt: new Date(createdAtMilliseconds).toISOString(),
      targetPath,
      ownershipToken,
    })}\n`,
  );
}

/** Closes a half-built lock and removes it only because this process created it. */
async function discardCreatedLock(
  fileSystem: InstallerTransactionFileSystem,
  close: () => Promise<void>,
  lockPath: string,
): Promise<void> {
  try {
    await close();
  } catch {
    // The descriptor is already unusable; the lock file still needs removing.
  }
  try {
    await fileSystem.unlink(lockPath);
  } catch {
    // A leftover lock is reported through the caller's error and inspected manually.
  }
}

async function createLockFile(
  dependencies: InstallerLockDependencies,
  targetPath: string,
  lockPath: string,
  lockedCode: LockedCode,
  ownershipToken: string,
): Promise<HeldInstallerLock> {
  const { clock, fileSystem, processId } = dependencies;
  const handle = await fileSystem.createExclusiveNoFollow(
    lockPath,
    lockFileMode,
  );
  let identity: InstallerFileStat;
  try {
    identity = await handle.stat();
    if (identity.kind !== "regular-file") {
      throw new InstallerFileSystemError("IO_FAILED");
    }
    await handle.writeAll(
      serializeLockMetadata(processId, clock.now(), targetPath, ownershipToken),
    );
    await handle.sync();
    await handle.close();
  } catch (error) {
    await discardCreatedLock(fileSystem, () => handle.close(), lockPath);
    throw error;
  }
  return { identity, lockedCode, lockPath, ownershipToken, released: false };
}

/** Retries only on contention, spending at most the total budget across all waits. */
async function acquireLock(
  dependencies: InstallerLockDependencies,
  targetPath: string,
  lockPath: string,
  lockedCode: LockedCode,
  writeFailedCode: WriteFailedCode,
): Promise<HeldInstallerLock> {
  const { clock, randomBytes, signal } = dependencies;
  const ownershipToken = mintOwnershipToken(randomBytes, writeFailedCode);
  const startedAt = clock.monotonicNow();
  let waitMilliseconds = initialLockWaitMilliseconds;

  while (true) {
    throwIfCancelled(signal);
    try {
      return await createLockFile(
        dependencies,
        targetPath,
        lockPath,
        lockedCode,
        ownershipToken,
      );
    } catch (error) {
      if (!isInstallerFileSystemError(error, "ALREADY_EXISTS")) {
        throw new InstallerError(writeFailedCode, error);
      }
    }
    const remaining =
      totalLockWaitMilliseconds - (clock.monotonicNow() - startedAt);
    if (remaining <= 0) throw new InstallerError(lockedCode);
    await clock.wait(Math.min(waitMilliseconds, remaining));
    waitMilliseconds = Math.min(
      waitMilliseconds * 2,
      maximumLockWaitMilliseconds,
    );
  }
}

function ownsLock(
  lock: HeldInstallerLock,
  current: InstallerFileStat,
  metadata: Uint8Array,
): boolean {
  if (
    current.kind !== "regular-file" ||
    current.dev !== lock.identity.dev ||
    current.ino !== lock.identity.ino
  ) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(metadata));
  } catch {
    return false;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).ownershipToken === lock.ownershipToken
  );
}

/** Never throws: a lock this process cannot prove it owns is left for manual inspection. */
async function releaseLock(
  fileSystem: InstallerTransactionFileSystem,
  lock: HeldInstallerLock,
): Promise<InstallerError | undefined> {
  if (lock.released) return undefined;
  try {
    const handle = await fileSystem.openReadNoFollow(lock.lockPath);
    let current: InstallerFileStat;
    let metadata: Uint8Array;
    try {
      current = await handle.stat();
      metadata = await handle.readAll(maximumLockMetadataBytes);
    } finally {
      await handle.close();
    }
    if (!ownsLock(lock, current, metadata)) {
      return new InstallerError(lock.lockedCode);
    }
    await fileSystem.unlink(lock.lockPath);
    lock.released = true;
    return undefined;
  } catch (error) {
    return new InstallerError(lock.lockedCode, error);
  }
}

export async function acquireInstallerLocks(
  input: AcquireInstallerLocksInput,
): Promise<OwnedInstallerLocks> {
  const { configPath, dependencies, statePath } = input;
  const { fileSystem } = dependencies;

  const state = await acquireLock(
    dependencies,
    statePath,
    stateLockPath(statePath),
    "STATE_LOCKED",
    "STATE_WRITE_FAILED",
  );
  let config: HeldInstallerLock;
  try {
    config = await acquireLock(
      dependencies,
      configPath,
      configLockPath(configPath),
      "CONFIG_LOCKED",
      "CONFIG_WRITE_FAILED",
    );
  } catch (error) {
    await releaseLock(fileSystem, state);
    throw error;
  }

  return Object.freeze({
    paths: Object.freeze([state.lockPath, config.lockPath]),
    release: async (primaryError?: unknown) => {
      const configFailure = await releaseLock(fileSystem, config);
      const stateFailure = await releaseLock(fileSystem, state);
      const failure = primaryError ?? stateFailure ?? configFailure;
      if (failure !== undefined) throw failure;
    },
  });
}
