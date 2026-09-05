import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { InstallerFileSystem } from "../src/file-system.js";
import { InstallerError } from "../src/installer-error.js";
import {
  createEmptyInstallerState,
  installationKey,
  loadInstallerState,
  type ManagedInstallation,
  type StateTargetContracts,
  validateInstallerStateBytes,
} from "../src/installer-state.js";
import {
  configurationTargetIds,
  type RegistryCompatibilityAdapters,
  validateRegistryBytes,
} from "../src/registry.js";

const encoder = new TextEncoder();
const stateByteLimit = 16_777_216;
const homeDirectory = "/home/tester";
const currentUserId = 1_000;
const ownership = {
  kind: "posix-user",
  reportedOwnerId: currentUserId,
} as const;
const secretSentinel = "STATE_SECRET_SENTINEL_73f663";
const supportedAdapters = Object.freeze(
  Object.fromEntries(
    configurationTargetIds.map((targetId) => [
      targetId,
      () => ({ supported: true as const }),
    ]),
  ) as unknown as RegistryCompatibilityAdapters,
);

const toggleStrategies = {
  antigravity: "native-disabled",
  "claude-code": "detached",
  "claude-desktop": "detached",
  codex: "native-enabled",
  cursor: "detached",
  "grok-build": "native-enabled",
  hermes: "native-enabled",
  "kimi-code": "native-enabled",
  openclaw: "native-enabled",
  "opencode-v2": "native-disabled",
  vscode: "detached",
} as const;

const targetContracts = Object.freeze(
  Object.fromEntries(
    configurationTargetIds.map((targetId) => [
      targetId,
      Object.freeze({
        configPath: `/home/tester/config/${targetId}.json`,
        targetContractVersion: 1 as const,
        toggleStrategy: toggleStrategies[targetId],
      }),
    ]),
  ) as unknown as StateTargetContracts,
);

function record(
  overrides: Partial<ManagedInstallation> = {},
): ManagedInstallation {
  return {
    entryId: "support-engine",
    registryVersion: "1.0.0",
    targetId: "codex",
    configPath: targetContracts.codex.configPath,
    serverName: "invokta-support",
    definitionSha256: "a".repeat(64),
    targetContractVersion: 1,
    toggleStrategy: "native-enabled",
    adopted: false,
    installedAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

function stateBytes(records: readonly ManagedInstallation[]): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      schemaVersion: 1,
      installations: Object.fromEntries(
        records.map((installation) => [
          installationKey(
            installation.entryId,
            installation.targetId,
            installation.configPath,
          ),
          installation,
        ]),
      ),
    }),
  );
}

function expectInvalid(bytes: Uint8Array, code?: string): void {
  const result = validateInstallerStateBytes(bytes, targetContracts);
  expect(result.ok).toBe(false);
  if (!result.ok && code !== undefined) {
    expect(result.issues.map((issue) => issue.code)).toContain(code);
  }
}

function pathInspection(path: string) {
  const filePath = join(homeDirectory, ".local/state/invokta/installer.json");
  return {
    kind:
      path === filePath ? ("regular-file" as const) : ("directory" as const),
    ownerId: currentUserId,
    realPath: resolve(path),
  };
}

function stateFileSystem(
  bytes: Uint8Array,
  inspectPath: InstallerFileSystem["inspectPath"] = async (path) =>
    pathInspection(path),
): InstallerFileSystem {
  return {
    inspectPath: vi.fn(inspectPath),
    readFile: vi.fn(async () => bytes),
  };
}

describe("installer state validation", () => {
  it("accepts a closed version-one state and historical registry entry IDs", () => {
    const installation = record({ entryId: "historical-engine-2042" });
    const result = validateInstallerStateBytes(
      stateBytes([installation]),
      targetContracts,
    );

    expect(result).toEqual({
      ok: true,
      state: {
        schemaVersion: 1,
        installations: {
          [installationKey(
            installation.entryId,
            installation.targetId,
            installation.configPath,
          )]: installation,
        },
      },
    });
    if (result.ok) {
      expect(Object.isFrozen(result.state)).toBe(true);
      expect(Object.isFrozen(result.state.installations)).toBe(true);
    }
  });

  it.each([
    [
      "unknown root key",
      { schemaVersion: 1, installations: {}, extra: true },
      "UNKNOWN_KEY",
    ],
    [
      "unknown version",
      { schemaVersion: 2, installations: {} },
      "INVALID_SCHEMA_VERSION",
    ],
    [
      "unknown record key",
      {
        schemaVersion: 1,
        installations: {
          [installationKey(
            "support-engine",
            "codex",
            targetContracts.codex.configPath,
          )]: {
            ...record(),
            extra: secretSentinel,
          },
        },
      },
      "UNKNOWN_KEY",
    ],
    [
      "malformed digest",
      {
        schemaVersion: 1,
        installations: {
          [installationKey(
            "support-engine",
            "codex",
            targetContracts.codex.configPath,
          )]: record({
            definitionSha256: "ABC",
          }),
        },
      },
      "INVALID_DIGEST",
    ],
    [
      "unknown target contract version",
      {
        schemaVersion: 1,
        installations: {
          [installationKey(
            "support-engine",
            "codex",
            targetContracts.codex.configPath,
          )]: {
            ...record(),
            targetContractVersion: 2,
          },
        },
      },
      "INVALID_TARGET_CONTRACT_VERSION",
    ],
    [
      "strategy mismatch",
      {
        schemaVersion: 1,
        installations: {
          [installationKey(
            "support-engine",
            "codex",
            targetContracts.codex.configPath,
          )]: record({
            toggleStrategy: "native-disabled",
          }),
        },
      },
      "TOGGLE_STRATEGY_MISMATCH",
    ],
    [
      "non-UTC timestamp",
      {
        schemaVersion: 1,
        installations: {
          [installationKey(
            "support-engine",
            "codex",
            targetContracts.codex.configPath,
          )]: record({
            installedAt: "2026-07-28T09:00:00-03:00",
          }),
        },
      },
      "INVALID_TIMESTAMP",
    ],
    [
      "impossible timestamp",
      {
        schemaVersion: 1,
        installations: {
          [installationKey(
            "support-engine",
            "codex",
            targetContracts.codex.configPath,
          )]: record({
            installedAt: "2026-02-30T12:00:00Z",
          }),
        },
      },
      "INVALID_TIMESTAMP",
    ],
    [
      "backwards timestamp",
      {
        schemaVersion: 1,
        installations: {
          [installationKey(
            "support-engine",
            "codex",
            targetContracts.codex.configPath,
          )]: record({
            installedAt: "2026-07-28T12:00:00.001Z",
            updatedAt: "2026-07-28T12:00:00.0009Z",
          }),
        },
      },
      "TIMESTAMP_ORDER",
    ],
  ])("rejects %s without retaining values", (_name, value, code) => {
    const bytes = encoder.encode(JSON.stringify(value));
    const result = validateInstallerStateBytes(bytes, targetContracts);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain(code);
      expect(JSON.stringify(result.issues)).not.toContain(secretSentinel);
    }
  });

  it("rejects duplicate JSON keys before ownership is interpreted", () => {
    expectInvalid(
      encoder.encode(
        '{"schemaVersion":1,"schemaVersion":1,"installations":{}}',
      ),
      "DUPLICATE_KEY",
    );
  });

  it("enforces tuple keys, unique entry-target ownership, and current path", () => {
    const first = record();
    const relocated = record({ configPath: "/home/tester/old/config.toml" });
    const duplicatePairDocument = {
      schemaVersion: 1,
      installations: {
        [installationKey(first.entryId, first.targetId, first.configPath)]:
          first,
        [installationKey(
          relocated.entryId,
          relocated.targetId,
          relocated.configPath,
        )]: relocated,
      },
    };
    const wrongKeyDocument = {
      schemaVersion: 1,
      installations: { wrong: first },
    };

    expectInvalid(
      encoder.encode(JSON.stringify(duplicatePairDocument)),
      "DUPLICATE_INSTALLATION",
    );
    expectInvalid(
      encoder.encode(JSON.stringify(duplicatePairDocument)),
      "CONFIG_PATH_RELOCATED",
    );
    expectInvalid(
      encoder.encode(JSON.stringify(wrongKeyDocument)),
      "KEY_MISMATCH",
    );

    const nonCanonicalContracts = {
      ...targetContracts,
      codex: {
        ...targetContracts.codex,
        configPath: "/home/tester/config/../config/codex.json",
      },
    };
    const nonCanonicalRecord = record({
      configPath: nonCanonicalContracts.codex.configPath,
    });
    const nonCanonical = validateInstallerStateBytes(
      stateBytes([nonCanonicalRecord]),
      nonCanonicalContracts,
    );
    expect(nonCanonical.ok).toBe(false);
    if (!nonCanonical.ok) {
      expect(nonCanonical.issues.map((issue) => issue.code)).toContain(
        "CONFIG_PATH_RELOCATED",
      );
    }
  });

  it("accepts a relocated path only for unavailable-target inspection", () => {
    const relocated = record({
      configPath: "/home/tester/old/config.toml",
    });
    const bytes = encoder.encode(
      JSON.stringify({
        schemaVersion: 1,
        installations: {
          [installationKey(
            relocated.entryId,
            relocated.targetId,
            relocated.configPath,
          )]: relocated,
        },
      }),
    );

    expect(validateInstallerStateBytes(bytes, targetContracts).ok).toBe(false);
    expect(
      validateInstallerStateBytes(bytes, targetContracts, {
        allowUnavailableTargetContracts: true,
      }),
    ).toMatchObject({ ok: true });
  });

  it("does not apply a component string limit to the derived tuple key", () => {
    const longPath = `/home/tester/${Array.from({ length: 21 }, () => "p".repeat(190)).join("/")}/config.json`;
    const longContracts = {
      ...targetContracts,
      codex: { ...targetContracts.codex, configPath: longPath },
    };
    const installation = record({
      entryId: `a${"b".repeat(127)}`,
      configPath: longPath,
    });

    expect(
      installationKey(
        installation.entryId,
        installation.targetId,
        installation.configPath,
      ).length,
    ).toBeGreaterThan(4_096);
    expect(
      validateInstallerStateBytes(stateBytes([installation]), longContracts).ok,
    ).toBe(true);
  });

  it("enforces native and detached suspended descriptor structure", () => {
    const suspendedDescriptor = {
      name: "invokta-support",
      transport: {
        type: "streamable-http" as const,
        url: "https://example.com/mcp",
        authentication: { type: "none" as const },
        headersFromEnv: { "x-tenant": "TENANT_ID" },
      },
    };
    const native = {
      ...record(),
      suspendedDescriptor,
    };
    const detached = record({
      targetId: "cursor",
      configPath: targetContracts.cursor.configPath,
      toggleStrategy: "detached",
      suspendedDescriptor,
    });

    expectInvalid(stateBytes([native]), "SUSPENDED_DESCRIPTOR_FORBIDDEN");
    expect(
      validateInstallerStateBytes(stateBytes([detached]), targetContracts).ok,
    ).toBe(true);
    expectInvalid(
      stateBytes([
        {
          ...detached,
          suspendedDescriptor: {
            ...suspendedDescriptor,
            name: "another-server",
          },
        },
      ]),
      "SUSPENDED_DESCRIPTOR_MISMATCH",
    );
    expectInvalid(
      stateBytes([
        {
          ...detached,
          suspendedDescriptor: {
            ...suspendedDescriptor,
            transport: {
              ...suspendedDescriptor.transport,
              url: "https://user:secret@example.com/mcp",
            },
          },
        },
      ]),
      "INVALID_URL",
    );
    expectInvalid(
      stateBytes([
        {
          ...detached,
          suspendedDescriptor: {
            ...suspendedDescriptor,
            transport: {
              ...suspendedDescriptor.transport,
              url: "https://example.com/mcp/../mcp",
            },
          },
        },
      ]),
      "INVALID_URL",
    );
  });

  it("allows repeated stdio arguments but rejects repeated forwarded environment names", () => {
    const base = record({
      targetId: "cursor",
      configPath: targetContracts.cursor.configPath,
      toggleStrategy: "detached",
      suspendedDescriptor: {
        name: "invokta-support",
        transport: {
          type: "stdio",
          command: "support-mcp",
          args: ["--feature", "--feature"],
          forwardEnv: ["SUPPORT_TOKEN"],
        },
      },
    });

    expect(
      validateInstallerStateBytes(stateBytes([base]), targetContracts).ok,
    ).toBe(true);
    expectInvalid(
      stateBytes([
        {
          ...base,
          suspendedDescriptor: {
            name: "invokta-support",
            transport: {
              type: "stdio",
              command: "support-mcp",
              args: [],
              forwardEnv: ["SUPPORT_TOKEN", "SUPPORT_TOKEN"],
            },
          },
        },
      ]),
      "DUPLICATE_VALUE",
    );
  });

  it.each([
    ["overlong", "x".repeat(4_097)],
    ["lone surrogate", `x\ud800`],
  ])(
    "validates every suspended HTTP header name for %s Unicode",
    (_name, header) => {
      const installation = record({
        targetId: "cursor",
        configPath: targetContracts.cursor.configPath,
        toggleStrategy: "detached",
        suspendedDescriptor: {
          name: "invokta-support",
          transport: {
            type: "streamable-http",
            url: "https://example.com/mcp",
            authentication: { type: "none" },
            headersFromEnv: { [header]: "SUPPORT_TOKEN" },
          },
        },
      });

      expectInvalid(stateBytes([installation]), "INVALID_STRING");
    },
  );

  it.each([
    ["https://example.com/mcp", true],
    ["http://127.0.0.1:3100/e/brain/mcp", true],
    ["https://gateway.example.com/e/brain/mcp", true],
    [`https://gateway.example.com/${"a".repeat(251)}/mcp`, true],
    [`https://gateway.example.com/${"a".repeat(252)}/mcp`, false],
    ["https://gateway.example.com/e//brain/mcp", false],
    ["https://gateway.example.com/e/./brain/mcp", false],
    ["https://gateway.example.com/e/%62rain/mcp", false],
    ["https://gateway.example.com/e/brain/mcp/", false],
    ["http://127.0.0.1/mcp", true],
    ["http://[::1]/mcp", true],
    ["https:///mcp", false],
    ["https://example.com/./mcp", false],
    ["https://example.com/a/../mcp", false],
    ["https://example.com/%2e%2e/mcp", false],
    ["https://example.com/%6dcp", false],
    ["https://example.com/mcp?", false],
    ["https://example.com/mcp#", false],
    ["http://127.0.0.01/mcp", false],
    ["http://2130706433/mcp", false],
    ["http://[0:0:0:0:0:0:0:1]/mcp", false],
  ])(
    "keeps suspended and registry raw URL validity in parity for %s",
    (url, valid) => {
      const registryBytes = encoder.encode(
        JSON.stringify({
          schemaVersion: 1,
          entries: [
            {
              id: "support-engine",
              version: "1.0.0",
              title: "Support Engine",
              description: "Support tools.",
              capabilityIds: ["support.classify"],
              server: {
                name: "invokta-support",
                transport: { type: "streamable-http", url },
              },
            },
          ],
        }),
      );
      const installation = record({
        targetId: "cursor",
        configPath: targetContracts.cursor.configPath,
        toggleStrategy: "detached",
        suspendedDescriptor: {
          name: "invokta-support",
          transport: {
            type: "streamable-http",
            url,
            authentication: { type: "none" },
            headersFromEnv: {},
          },
        },
      });

      expect(validateRegistryBytes(registryBytes, supportedAdapters).ok).toBe(
        valid,
      );
      expect(
        validateInstallerStateBytes(stateBytes([installation]), targetContracts)
          .ok,
      ).toBe(valid);
    },
  );

  it("accepts exactly 11,000 records and rejects record 11,001", () => {
    const records = Array.from({ length: 11_001 }, (_, index) =>
      record({ entryId: `historical-${index}` }),
    );

    expect(
      validateInstallerStateBytes(
        stateBytes(records.slice(0, 11_000)),
        targetContracts,
      ).ok,
    ).toBe(true);
    expectInvalid(stateBytes(records), "INSTALLATIONS_TOO_LARGE");
  });

  it("accepts exactly 16 MiB and rejects one byte more", () => {
    const base = JSON.stringify({ schemaVersion: 1, installations: {} });
    const exact = encoder.encode(
      `${base.slice(0, -1)}${" ".repeat(stateByteLimit - encoder.encode(base).byteLength)}}`,
    );
    const oversized = new Uint8Array(stateByteLimit + 1);
    oversized.set(exact);
    oversized[stateByteLimit] = 0x20;

    expect(exact.byteLength).toBe(stateByteLimit);
    expect(
      Buffer.compare(
        Buffer.from(oversized.buffer, oversized.byteOffset, stateByteLimit),
        Buffer.from(exact.buffer, exact.byteOffset, exact.byteLength),
      ),
    ).toBe(0);
    expect(oversized[stateByteLimit]).toBe(0x20);
    expect(validateInstallerStateBytes(exact, targetContracts).ok).toBe(true);
    expectInvalid(oversized, "STATE_TOO_LARGE");
  });

  it.each([
    [
      "a UTF-8 BOM",
      new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
      "BOM_FORBIDDEN",
    ],
    [
      "malformed UTF-8",
      new Uint8Array([0x7b, 0x22, 0xc3, 0x28]),
      "INVALID_UTF8",
    ],
  ])("rejects %s", (_name, bytes, code) => {
    expectInvalid(bytes, code);
  });
});

describe("read-only installer state loading", () => {
  it("resolves and reads the package-owned default state location component by component", async () => {
    const bytes = stateBytes([record()]);
    const fileSystem = stateFileSystem(bytes);

    const loaded = await loadInstallerState({
      ownership,
      environment: { get: () => undefined },
      fileSystem,
      homeDirectory,
      targetContracts,
    });

    expect(loaded.path).toBe(
      "/home/tester/.local/state/invokta/installer.json",
    );
    expect(loaded.state.schemaVersion).toBe(1);
    expect(fileSystem.inspectPath).toHaveBeenCalledTimes(5);
    expect(fileSystem.readFile).toHaveBeenCalledTimes(1);
  });

  it("honors a safe absolute XDG_STATE_HOME and returns empty state when absent", async () => {
    const inspectPath = vi.fn<InstallerFileSystem["inspectPath"]>(
      async (path) =>
        path === "/var/user-state"
          ? { kind: "directory", ownerId: currentUserId, realPath: path }
          : { kind: "missing" },
    );
    const fileSystem = stateFileSystem(new Uint8Array(), inspectPath);

    const loaded = await loadInstallerState({
      ownership,
      environment: {
        get: (name) =>
          name === "XDG_STATE_HOME" ? "/var/user-state" : undefined,
      },
      fileSystem,
      homeDirectory,
      targetContracts,
    });

    expect(loaded).toEqual({
      path: "/var/user-state/invokta/installer.json",
      state: createEmptyInstallerState(),
    });
    expect(fileSystem.readFile).not.toHaveBeenCalled();
  });

  it.each(["", "relative/state", "/tmp/state\0escape", 42])(
    "rejects unsafe XDG_STATE_HOME %j before reading",
    async (xdgStateHome) => {
      const fileSystem = stateFileSystem(new Uint8Array());

      await expect(
        loadInstallerState({
          ownership,
          environment: { get: () => xdgStateHome },
          fileSystem,
          homeDirectory,
          targetContracts,
        }),
      ).rejects.toMatchObject({ code: "STATE_INVALID" });
      expect(fileSystem.readFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "symbolic link",
      { kind: "symbolic-link" as const, ownerId: currentUserId },
    ],
    [
      "wrong owner",
      {
        kind: "directory" as const,
        ownerId: 999,
        realPath: "/home/tester/.local",
      },
    ],
  ])("maps an unsafe %s component to STATE_INVALID", async (_name, unsafe) => {
    const unsafePath = "/home/tester/.local";
    const fileSystem = stateFileSystem(
      new Uint8Array(),
      vi.fn(async (path) =>
        path === unsafePath ? unsafe : pathInspection(path),
      ),
    );

    await expect(
      loadInstallerState({
        ownership,
        environment: { get: () => undefined },
        fileSystem,
        homeDirectory,
        targetContracts,
      }),
    ).rejects.toMatchObject({ code: "STATE_INVALID" });
    expect(fileSystem.readFile).not.toHaveBeenCalled();
  });

  it("maps read failures separately from invalid bytes and leaks no content", async () => {
    const readFailureFileSystem = stateFileSystem(stateBytes([]));
    vi.mocked(readFailureFileSystem.readFile).mockRejectedValueOnce(
      new Error(`disk failure ${secretSentinel}`),
    );
    const invalidFileSystem = stateFileSystem(
      encoder.encode(
        `{"schemaVersion":1,"installations":{},"secret":"${secretSentinel}"}`,
      ),
    );
    const options = {
      ownership,
      environment: { get: () => undefined },
      homeDirectory,
      targetContracts,
    } as const;

    const readError = await loadInstallerState({
      ...options,
      fileSystem: readFailureFileSystem,
    }).catch((error: unknown) => error);
    const invalidError = await loadInstallerState({
      ...options,
      fileSystem: invalidFileSystem,
    }).catch((error: unknown) => error);

    expect(readError).toBeInstanceOf(InstallerError);
    expect(readError).toMatchObject({ code: "STATE_READ_FAILED" });
    expect(invalidError).toBeInstanceOf(InstallerError);
    expect(invalidError).toMatchObject({ code: "STATE_INVALID" });
    expect(String(readError)).not.toContain(secretSentinel);
    expect(String(invalidError)).not.toContain(secretSentinel);
    expect(JSON.stringify(invalidError)).not.toContain(secretSentinel);
  });

  it("maps path inspection failures to STATE_READ_FAILED", async () => {
    const fileSystem = stateFileSystem(
      stateBytes([]),
      vi.fn(async () => {
        throw new Error("inspection unavailable");
      }),
    );

    await expect(
      loadInstallerState({
        ownership,
        environment: { get: () => undefined },
        fileSystem,
        homeDirectory,
        targetContracts,
      }),
    ).rejects.toMatchObject({ code: "STATE_READ_FAILED" });
    expect(fileSystem.readFile).not.toHaveBeenCalled();
  });

  it("loads state under the Windows principal identity from constant owner ids", async () => {
    const fileSystem = stateFileSystem(
      stateBytes([record()]),
      vi.fn(async (path: string) => ({
        ...pathInspection(path),
        ownerId: 0,
      })),
    );

    const loaded = await loadInstallerState({
      ownership: { kind: "windows-principal", reportedOwnerId: 0 },
      environment: { get: () => undefined },
      fileSystem,
      homeDirectory,
      targetContracts,
    });

    expect(loaded.path).toBe(
      "/home/tester/.local/state/invokta/installer.json",
    );
    expect(Object.keys(loaded.state.installations)).toHaveLength(1);
  });

  it("fails closed when no ownership identity could be captured", async () => {
    const fileSystem = stateFileSystem(stateBytes([record()]));

    await expect(
      loadInstallerState({
        ownership: undefined,
        environment: { get: () => undefined },
        fileSystem,
        homeDirectory,
        targetContracts,
      }),
    ).rejects.toMatchObject({ code: "STATE_INVALID" });
    expect(fileSystem.readFile).not.toHaveBeenCalled();
  });
});
