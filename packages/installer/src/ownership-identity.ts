/** Node reports this constant owner id for every filesystem object on Windows. */
const windowsReportedOwnerId = 0;

/** POSIX ownership: every trusted path component must be owned by this uid. */
export interface PosixUserOwnershipIdentity {
  readonly kind: "posix-user";
  readonly reportedOwnerId: number;
}

/**
 * Windows ownership: Node cannot expose the invoking user's security
 * identifier, and `lstat` reports the same owner id for every path, so an
 * owner-id comparison proves nothing. Confinement instead relies on the
 * user-profile access-control lists together with the installer's unchanged
 * no-follow, path-identity, and containment checks.
 */
export interface WindowsPrincipalOwnershipIdentity {
  readonly kind: "windows-principal";
  readonly reportedOwnerId: typeof windowsReportedOwnerId;
}

export type InstallerOwnershipIdentity =
  | PosixUserOwnershipIdentity
  | WindowsPrincipalOwnershipIdentity;

export interface OwnershipProcessLike {
  readonly platform: NodeJS.Platform;
  readonly getuid?: (() => number) | undefined;
}

export function validOwnershipIdentity(
  identity: InstallerOwnershipIdentity,
): boolean {
  if (identity.kind === "posix-user") {
    return (
      Number.isSafeInteger(identity.reportedOwnerId) &&
      identity.reportedOwnerId >= 0
    );
  }
  return (
    identity.kind === "windows-principal" &&
    identity.reportedOwnerId === windowsReportedOwnerId
  );
}

/** Only POSIX identities can promise exact private file modes such as `0o700`. */
export function enforcesPosixFileModes(
  identity: InstallerOwnershipIdentity,
): boolean {
  return identity.kind === "posix-user";
}

/**
 * Captures the invoking user's ownership identity, or `undefined` when the
 * platform exposes neither a POSIX uid nor Windows principal semantics; every
 * consumer fails closed on `undefined`.
 */
export function captureProcessOwnershipIdentity(
  processLike: OwnershipProcessLike = process,
): InstallerOwnershipIdentity | undefined {
  const uid = processLike.getuid?.();
  if (uid !== undefined) {
    if (!Number.isSafeInteger(uid) || uid < 0) return undefined;
    return Object.freeze({ kind: "posix-user", reportedOwnerId: uid });
  }
  if (processLike.platform !== "win32") return undefined;
  return Object.freeze({
    kind: "windows-principal",
    reportedOwnerId: windowsReportedOwnerId,
  });
}
