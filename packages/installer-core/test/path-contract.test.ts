import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type {
  InstallerNoFollowPathInspection,
  InstallerTransactionFileSystem,
} from "../src/file-system.js";
import { loadInstallerState } from "../src/installer-state.js";
import { createNodeFileSystem } from "../src/node-file-system.js";
import {
  contractOwnerValid,
  createPosixPathContract,
  createWindowsPathContract,
  ownerAccepted,
  resolvePathSafetyContract,
} from "../src/path-contract.js";
import { capturePathRoot } from "../src/path-identity.js";
import type { InstallerEnvironment } from "../src/target-config-evidence.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A filesystem whose every path is a directory owned by `ownerId`. */
function ownedBy(ownerId: number): InstallerTransactionFileSystem {
  const stat: InstallerNoFollowPathInspection = {
    kind: "directory",
    dev: 1n,
    ino: 2n,
    uid: ownerId,
    gid: ownerId,
    mode: 0o700,
  };
  return {
    readFile: async () => new Uint8Array(),
    inspectPath: async () => ({
      kind: "directory",
      ownerId,
      realPath: "/root",
    }),
    inspectPathNoFollow: async () => stat,
    openReadNoFollow: async () => {
      throw new Error("unused");
    },
    createExclusiveNoFollow: async () => {
      throw new Error("unused");
    },
    mkdir: async () => undefined,
    rename: async () => undefined,
    unlink: async () => undefined,
  };
}

function environment(
  values: Readonly<Record<string, unknown>> = {},
): InstallerEnvironment {
  return { get: (name) => values[name] };
}

describe("path safety contracts", () => {
  it("selects a contract by platform", () => {
    expect(resolvePathSafetyContract({ platform: "win32" })).toMatchObject({
      name: "windows",
      expectedOwnerId: undefined,
      enforcesMode: false,
      opensWithoutFollowing: false,
      confinesToUserProfile: true,
    });
    expect(
      resolvePathSafetyContract({ platform: "linux", currentUserId: 501 }),
    ).toMatchObject({
      name: "posix",
      expectedOwnerId: 501,
      enforcesMode: true,
      opensWithoutFollowing: true,
      confinesToUserProfile: false,
    });
  });

  it("states its ownership assurance honestly", () => {
    const posix = createPosixPathContract(501);
    const windows = createWindowsPathContract();

    expect(ownerAccepted(posix, 501)).toBe(true);
    expect(ownerAccepted(posix, 0)).toBe(false);
    // Windows offers no ownership evidence at all; this is the documented gap.
    expect(ownerAccepted(windows, 0)).toBe(true);
    expect(ownerAccepted(windows, 999)).toBe(true);
    expect(contractOwnerValid(windows)).toBe(true);
    expect(contractOwnerValid(createPosixPathContract(-1))).toBe(false);
  });
});

describe("path identity under a contract", () => {
  it("rejects a root owned by another user under the POSIX contract", async () => {
    await expect(
      capturePathRoot(ownedBy(4242), {
        rootKind: "home",
        rootPath: "/root",
        currentUserId: 501,
      }),
    ).rejects.toMatchObject({ code: "ROOT_UNSAFE" });
  });

  it("accepts the same root under the Windows contract and records it", async () => {
    const root = await capturePathRoot(ownedBy(4242), {
      rootKind: "home",
      rootPath: "/root",
      currentUserId: -1,
      contract: createWindowsPathContract(),
    });

    expect(root.contract.name).toBe("windows");
    expect(root.uid).toBe(4242);
  });

  it("rejects an invalid POSIX owner before touching the filesystem", async () => {
    await expect(
      capturePathRoot(ownedBy(0), {
        rootKind: "home",
        rootPath: "/root",
        currentUserId: -1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
  });
});

describe("filesystem under the Windows contract", () => {
  it("refuses to open a link even without O_NOFOLLOW", async () => {
    const root = temporary("invokta-windows-fs-");
    const target = join(root, "real.json");
    const link = join(root, "link.json");
    writeFileSync(target, "{}\n");
    symlinkSync(target, link);
    const fileSystem = createNodeFileSystem({ platform: "win32" });

    await expect(fileSystem.openReadNoFollow(link)).rejects.toMatchObject({
      code: "SYMBOLIC_LINK",
    });
    const handle = await fileSystem.openReadNoFollow(target);
    await handle.close();
  });

  it("reports a missing path rather than following it", async () => {
    const root = temporary("invokta-windows-fs-");
    const fileSystem = createNodeFileSystem({ platform: "win32" });

    await expect(
      fileSystem.openReadNoFollow(join(root, "absent.json")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("creates a file and a directory without claiming permission bits", async () => {
    const root = temporary("invokta-windows-fs-");
    const fileSystem = createNodeFileSystem({ platform: "win32" });

    const handle = await fileSystem.createExclusiveNoFollow(
      join(root, "created.json"),
      0o600,
    );
    await handle.writeAll(new TextEncoder().encode("{}\n"));
    await handle.close();
    await fileSystem.mkdir(join(root, "created"), 0o700);

    await expect(
      fileSystem.createExclusiveNoFollow(join(root, "created.json"), 0o600),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });
});

describe("installer state under the Windows contract", () => {
  it("loads with no user id available", async () => {
    const home = temporary("invokta-windows-state-");
    mkdirSync(join(home, "state"), { recursive: true });

    const loaded = await loadInstallerState({
      currentUserId: undefined,
      contract: createWindowsPathContract(),
      environment: environment({ XDG_STATE_HOME: join(home, "state") }),
      fileSystem: createNodeFileSystem({ platform: "win32" }),
      homeDirectory: home,
      targetContracts: {} as never,
      allowUnavailableTargetContracts: true,
    });

    expect(loaded.state).toEqual({ schemaVersion: 1, installations: {} });
    expect(loaded.path).toBe(join(home, "state", "invokta", "installer.json"));
  });

  it("refuses a state directory outside the user profile", async () => {
    const home = temporary("invokta-windows-state-");
    const elsewhere = temporary("invokta-windows-outside-");

    await expect(
      loadInstallerState({
        currentUserId: undefined,
        contract: createWindowsPathContract(),
        environment: environment({ XDG_STATE_HOME: elsewhere }),
        fileSystem: createNodeFileSystem({ platform: "win32" }),
        homeDirectory: home,
        targetContracts: {} as never,
        allowUnavailableTargetContracts: true,
      }),
    ).rejects.toMatchObject({ code: "STATE_INVALID" });
  });

  it("still rejects a missing user id under the POSIX contract", async () => {
    const home = temporary("invokta-posix-state-");

    await expect(
      loadInstallerState({
        currentUserId: undefined,
        environment: environment(),
        fileSystem: createNodeFileSystem(),
        homeDirectory: home,
        targetContracts: {} as never,
        allowUnavailableTargetContracts: true,
      }),
    ).rejects.toMatchObject({ code: "STATE_INVALID" });
  });

  it("keeps a state directory outside the profile legal under POSIX", async () => {
    const home = temporary("invokta-posix-state-");
    const elsewhere = temporary("invokta-posix-outside-");

    const loaded = await loadInstallerState({
      currentUserId: process.getuid?.() ?? 0,
      environment: environment({ XDG_STATE_HOME: elsewhere }),
      fileSystem: createNodeFileSystem(),
      homeDirectory: home,
      targetContracts: {} as never,
      allowUnavailableTargetContracts: true,
    });

    expect(loaded.path).toBe(join(elsewhere, "invokta", "installer.json"));
  });
});
