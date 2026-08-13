import { describe, expect, it } from "vitest";

import {
  captureProcessOwnershipIdentity,
  enforcesPosixFileModes,
  validOwnershipIdentity,
} from "../src/ownership-identity.js";

describe("captureProcessOwnershipIdentity", () => {
  it("captures a frozen POSIX identity from an exposed uid", () => {
    const identity = captureProcessOwnershipIdentity({
      platform: "linux",
      getuid: () => 1_000,
    });

    expect(identity).toEqual({ kind: "posix-user", reportedOwnerId: 1_000 });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("captures the Windows principal identity when no uid is exposed", () => {
    const identity = captureProcessOwnershipIdentity({ platform: "win32" });

    expect(identity).toEqual({
      kind: "windows-principal",
      reportedOwnerId: 0,
    });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("prefers the uid over the platform when both are available", () => {
    expect(
      captureProcessOwnershipIdentity({
        platform: "win32",
        getuid: () => 7,
      }),
    ).toEqual({ kind: "posix-user", reportedOwnerId: 7 });
  });

  it.each([
    ["a non-Windows platform without a uid", { platform: "linux" as const }],
    ["a negative uid", { platform: "linux" as const, getuid: () => -1 }],
    [
      "an unsafe uid",
      { platform: "linux" as const, getuid: () => Number.MAX_SAFE_INTEGER + 2 },
    ],
  ])("fails closed for %s", (_label, processLike) => {
    expect(captureProcessOwnershipIdentity(processLike)).toBeUndefined();
  });

  it("captures this process's identity by default", () => {
    const identity = captureProcessOwnershipIdentity();

    if (process.getuid === undefined) {
      expect(identity?.kind).toBe(
        process.platform === "win32" ? "windows-principal" : undefined,
      );
    } else {
      expect(identity).toEqual({
        kind: "posix-user",
        reportedOwnerId: process.getuid(),
      });
    }
  });
});

describe("validOwnershipIdentity", () => {
  it.each([
    ["a POSIX uid", { kind: "posix-user", reportedOwnerId: 0 } as const, true],
    [
      "the Windows principal",
      { kind: "windows-principal", reportedOwnerId: 0 } as const,
      true,
    ],
    [
      "a negative POSIX uid",
      { kind: "posix-user", reportedOwnerId: -1 } as const,
      false,
    ],
    [
      "a fractional POSIX uid",
      { kind: "posix-user", reportedOwnerId: 0.5 } as const,
      false,
    ],
    [
      "a nonzero Windows owner id",
      { kind: "windows-principal", reportedOwnerId: 1 } as const,
      false,
    ],
  ])("classifies %s", (_label, identity, expected) => {
    expect(
      validOwnershipIdentity(
        identity as Parameters<typeof validOwnershipIdentity>[0],
      ),
    ).toBe(expected);
  });
});

describe("enforcesPosixFileModes", () => {
  it("enforces exact private modes only for POSIX identities", () => {
    expect(
      enforcesPosixFileModes({ kind: "posix-user", reportedOwnerId: 1_000 }),
    ).toBe(true);
    expect(
      enforcesPosixFileModes({ kind: "windows-principal", reportedOwnerId: 0 }),
    ).toBe(false);
  });
});
