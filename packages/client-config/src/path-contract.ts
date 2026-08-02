/**
 * Named path-safety contracts.
 *
 * The installer's original guarantees are POSIX guarantees: open without
 * following a link, prove that every path component belongs to the current
 * user, and enforce permission bits. Node exposes neither
 * `FILE_FLAG_OPEN_REPARSE_POINT` nor access control lists, so Windows cannot
 * make the same claims, and pretending otherwise would be the dangerous
 * outcome.
 *
 * ADR 0019 therefore names two contracts instead of weakening one. Every
 * result records which contract produced it, and ownership evidence is never
 * compared across them.
 */

export type PathContractName = "posix" | "windows";

export interface PathSafetyContract {
  readonly name: PathContractName;
  /**
   * The owner every path component must have, or `undefined` when the platform
   * cannot prove ownership at all. `undefined` is not "any owner is fine"; it
   * is "this platform offers no ownership evidence", and callers must say so.
   */
  readonly expectedOwnerId: number | undefined;
  /** Whether a created file or directory must carry exact permission bits. */
  readonly enforcesMode: boolean;
  /** Whether the platform can open a path without following a link. */
  readonly opensWithoutFollowing: boolean;
  /** Whether every configuration and state path must sit inside the profile. */
  readonly confinesToUserProfile: boolean;
}

export function createPosixPathContract(
  currentUserId: number,
): PathSafetyContract {
  return Object.freeze({
    name: "posix",
    expectedOwnerId: currentUserId,
    enforcesMode: true,
    opensWithoutFollowing: true,
    confinesToUserProfile: false,
  });
}

export function createWindowsPathContract(): PathSafetyContract {
  return Object.freeze({
    name: "windows",
    expectedOwnerId: undefined,
    enforcesMode: false,
    opensWithoutFollowing: false,
    confinesToUserProfile: true,
  });
}

export interface ResolvePathSafetyContractOptions {
  readonly platform?: NodeJS.Platform;
  readonly currentUserId?: number;
}

export function resolvePathSafetyContract(
  options: ResolvePathSafetyContractOptions = {},
): PathSafetyContract {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return createWindowsPathContract();
  return createPosixPathContract(
    options.currentUserId ?? process.getuid?.() ?? -1,
  );
}

/**
 * True when the contract accepts this owner for a path component. A contract
 * without ownership evidence accepts every owner by definition, which is
 * exactly the assurance gap the Windows contract documents.
 */
export function ownerAccepted(
  contract: PathSafetyContract,
  ownerId: number,
): boolean {
  return (
    contract.expectedOwnerId === undefined ||
    ownerId === contract.expectedOwnerId
  );
}

export function contractOwnerValid(contract: PathSafetyContract): boolean {
  return (
    contract.expectedOwnerId === undefined ||
    (Number.isSafeInteger(contract.expectedOwnerId) &&
      contract.expectedOwnerId >= 0)
  );
}
