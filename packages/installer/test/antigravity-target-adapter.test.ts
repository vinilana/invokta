import { describe, expect, it } from "vitest";
import {
  detectHarnesses,
  type TargetConfigEvidenceProbes,
} from "../src/harness-detection.js";
import { InstallerError } from "../src/installer-error.js";
import { fingerprintNormalizedDefinition } from "../src/jcs-fingerprint.js";
import {
  type CapabilityInstallDescriptor,
  configurationTargetIds,
} from "../src/registry.js";
import {
  type TargetConfigInspection,
  targetConfigByteLimit,
} from "../src/target-adapter.js";
import {
  configurationTargetAdapters,
  createTargetAdapterCounters,
  registryCompatibilityAdapters,
} from "../src/target-adapters.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function fixtureAbsentConfigEvidenceProbes(): TargetConfigEvidenceProbes {
  return Object.fromEntries(
    configurationTargetIds.map((targetId) => [
      targetId,
      async ({ homeDirectory }: { readonly homeDirectory: string }) => ({
        kind: "absent" as const,
        path: `${homeDirectory}/fixture-config/${targetId}`,
      }),
    ]),
  ) as unknown as TargetConfigEvidenceProbes;
}

function stdioDescriptor(
  forwardEnv: readonly string[] = [],
): CapabilityInstallDescriptor {
  return {
    id: "support-engine",
    version: "1.0.0",
    title: "Support Engine",
    description: "Classify and route support tickets.",
    capabilityIds: ["support.classify-ticket"],
    server: {
      name: "invokta-support",
      transport: {
        type: "stdio",
        command: "support-engine-mcp",
        args: ["serve", "--stdio"],
        forwardEnv,
      },
    },
  };
}

function httpDescriptor(options?: {
  readonly bearer?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}): CapabilityInstallDescriptor {
  return {
    ...stdioDescriptor(),
    server: {
      name: "invokta-support",
      transport: {
        type: "streamable-http",
        url: "https://support.example.com/mcp",
        authentication:
          options?.bearer === true
            ? { type: "bearer-env", variable: "SUPPORT_API_TOKEN" }
            : { type: "none" },
        headersFromEnv: options?.headers ?? {},
      },
    },
  };
}

function expectInstallerCode(
  action: () => unknown,
  code: InstallerError["code"],
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(InstallerError);
    expect((error as InstallerError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
}

function withBom(text: string): Uint8Array {
  const payload = encoder.encode(text);
  const bytes = new Uint8Array(payload.byteLength + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(payload, 3);
  return bytes;
}

function forgeCurrentServer(
  inspection: TargetConfigInspection,
  currentServer: TargetConfigInspection["currentServer"],
): TargetConfigInspection {
  const forged = { currentServer } as TargetConfigInspection;
  for (const symbol of Object.getOwnPropertySymbols(inspection)) {
    Object.defineProperty(forged, symbol, {
      configurable: false,
      enumerable: false,
      value: Reflect.get(inspection, symbol),
      writable: false,
    });
  }
  return Object.freeze(forged);
}

describe("shared Antigravity JSON target adapter", () => {
  it("treats an empty discovered config as an absent server collection", () => {
    const adapter = configurationTargetAdapters.antigravity;
    const inspection = adapter.inspect({
      source: new Uint8Array(),
      serverName: "invokta-support",
    });

    expect(inspection.currentServer).toEqual({ kind: "absent" });
    const patch = adapter.constructPatch({
      action: "install",
      definition: adapter.descriptorToDefinition(stdioDescriptor()),
      inspection,
    });
    expect(patch.kind).toBe("changed");
    if (patch.kind !== "changed") return;
    expect(JSON.parse(new TextDecoder().decode(patch.postImage))).toEqual({
      mcpServers: {
        "invokta-support": {
          command: "support-engine-mcp",
          args: ["serve", "--stdio"],
          disabled: false,
        },
      },
    });
  });

  it("publishes one exact native-disabled target contract for AGY and the IDE", async () => {
    const adapter = configurationTargetAdapters.antigravity;
    expect(adapter.metadata).toEqual({
      targetId: "antigravity",
      targetContractVersion: 1,
      format: "json",
      parentPath: ["mcpServers"],
      toggleStrategy: "native-disabled",
    });
    expect(Object.isFrozen(adapter.metadata)).toBe(true);

    const snapshot = await detectHarnesses({
      resolveHomeDirectory: () => "/users/tester",
      resolveExecutable: async (candidate) => {
        if (candidate !== "agy" && candidate !== "antigravity") {
          return undefined;
        }
        return {
          path: `/fixture/bin/${candidate}`,
          identity: {
            device: 7,
            inode: candidate === "agy" ? 11 : 12,
            realPath: `/fixture/real/${candidate}`,
          },
        };
      },
      configEvidenceProbes: fixtureAbsentConfigEvidenceProbes(),
    });
    const targets = snapshot.targets.filter(({ id }) => id === "antigravity");
    expect(targets).toEqual([
      expect.objectContaining({
        id: "antigravity",
        displayName: "Antigravity (AGY CLI + IDE)",
        surfaceIds: ["antigravity-cli", "antigravity-ide"],
        reloadHint:
          "In AGY use /mcp to reload; in the IDE refresh MCP servers or restart it.",
      }),
    ]);
    expect(configurationTargetAdapters[targets[0]?.id as "antigravity"]).toBe(
      adapter,
    );
  });

  it("maps only lossless stdio and credential-free HTTP descriptors", () => {
    const adapter = configurationTargetAdapters.antigravity;
    const stdio = stdioDescriptor();
    const http = httpDescriptor();
    expect(adapter.compatibility(stdio)).toEqual({ supported: true });
    expect(adapter.compatibility(http)).toEqual({ supported: true });
    expect(registryCompatibilityAdapters.antigravity(stdio)).toEqual({
      supported: true,
    });
    expect(adapter.descriptorToDefinition(stdio)).toEqual({
      transport: "stdio",
      command: "support-engine-mcp",
      args: ["serve", "--stdio"],
      disabled: false,
    });
    expect(adapter.descriptorToDefinition(http)).toEqual({
      transport: "streamable-http",
      serverUrl: "https://support.example.com/mcp",
      disabled: false,
    });
    expect(adapter.suspendedDescriptorToDefinition(stdio.server)).toEqual(
      adapter.descriptorToDefinition(stdio),
    );

    const unsupported = [
      {
        descriptor: stdioDescriptor(["SUPPORT_API_TOKEN"]),
        reason: "antigravity-forward-env-unsupported",
      },
      {
        descriptor: httpDescriptor({ bearer: true }),
        reason: "antigravity-http-authentication-unsupported",
      },
      {
        descriptor: httpDescriptor({
          headers: { "X-Tenant": "SUPPORT_TENANT" },
        }),
        reason: "antigravity-http-headers-unsupported",
      },
    ] as const;
    for (const { descriptor, reason } of unsupported) {
      expect(adapter.compatibility(descriptor)).toEqual({
        supported: false,
        reason,
      });
      expectInstallerCode(
        () => adapter.descriptorToDefinition(descriptor),
        "TARGET_UNSUPPORTED",
      );
      expectInstallerCode(
        () => adapter.suspendedDescriptorToDefinition(descriptor.server),
        "TARGET_UNSUPPORTED",
      );
    }
  });

  it("writes exact native shapes without the synthetic transport field", () => {
    const adapter = configurationTargetAdapters.antigravity;
    for (const [descriptor, expected] of [
      [
        stdioDescriptor(),
        {
          command: "support-engine-mcp",
          args: ["serve", "--stdio"],
          disabled: false,
        },
      ],
      [
        httpDescriptor(),
        {
          serverUrl: "https://support.example.com/mcp",
          disabled: false,
        },
      ],
    ] as const) {
      const definition = adapter.descriptorToDefinition(descriptor);
      const patch = adapter.constructPatch({
        action: "install",
        definition,
        inspection: adapter.inspect({
          source: undefined,
          serverName: descriptor.server.name,
        }),
      });
      expect(patch.kind).toBe("changed");
      if (patch.kind !== "changed") continue;
      const text = decoder.decode(patch.postImage);
      expect(text.endsWith("\n")).toBe(true);
      expect(text).not.toContain('"transport"');
      expect(JSON.parse(text)).toEqual({
        mcpServers: { "invokta-support": expected },
      });
      expect(
        adapter.inspect({
          source: patch.postImage,
          serverName: descriptor.server.name,
        }).currentServer,
      ).toEqual({ kind: "present", definition });
    }
  });

  it("normalizes omitted disabled as false and toggles only the native field", () => {
    const adapter = configurationTargetAdapters.antigravity;
    const source = withBom(
      [
        "{",
        '  "future": {"__proto__":{"polluted":false}},',
        '  "mcpServers": {',
        '    "other": {"command":"keep","args":[]},',
        '    "invokta-support": {"command":"support-engine-mcp","args":[],"future":{"nested":[1,true,null]}}',
        "  },",
        '  "tail": true',
        "}",
      ].join("\r\n"),
    );
    const inspection = adapter.inspect({
      source,
      serverName: "invokta-support",
    });
    expect(inspection.currentServer).toEqual({
      kind: "present",
      definition: {
        command: "support-engine-mcp",
        args: [],
        future: { nested: [1, true, null] },
        transport: "stdio",
        disabled: false,
      },
    });
    const unchangedCounters = createTargetAdapterCounters();
    expect(
      adapter.constructPatch({
        action: "enable",
        inspection,
        counters: unchangedCounters,
      }),
    ).toEqual({ kind: "unchanged" });
    expect(unchangedCounters.patchConstructionPasses).toBe(0);

    const disabled = adapter.constructPatch({
      action: "disable",
      inspection,
    });
    expect(disabled.kind).toBe("changed");
    if (disabled.kind !== "changed") return;
    expect([...disabled.postImage.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const disabledText = decoder.decode(disabled.postImage);
    expect(disabledText.endsWith("\n")).toBe(false);
    expect(disabledText.replaceAll("\r\n", "")).not.toContain("\n");
    expect(disabledText).toContain('"disabled": true');
    for (const preserved of [
      '"future": {"__proto__":{"polluted":false}}',
      '"other": {"command":"keep","args":[]}',
      '"future":{"nested":[1,true,null]}',
      '"tail": true',
    ]) {
      expect(disabledText).toContain(preserved);
    }

    const enabled = adapter.constructPatch({
      action: "enable",
      inspection: adapter.inspect({
        source: disabled.postImage,
        serverName: "invokta-support",
      }),
    });
    expect(enabled.kind).toBe("changed");
    if (enabled.kind !== "changed") return;
    const enabledText = decoder.decode(enabled.postImage);
    expect(enabledText).toBe(
      disabledText.replace('"disabled": true', '"disabled": false'),
    );
    expect(
      adapter.inspect({
        source: enabled.postImage,
        serverName: "invokta-support",
      }).currentServer,
    ).toEqual({
      kind: "present",
      definition: {
        command: "support-engine-mcp",
        args: [],
        future: { nested: [1, true, null] },
        disabled: false,
        transport: "stdio",
      },
    });
  });

  it("fingerprints independently of disabled and rejects forged no-op inspections", () => {
    const adapter = configurationTargetAdapters.antigravity;
    const inspect = (disabled: boolean) =>
      adapter.inspect({
        source: encoder.encode(
          JSON.stringify({
            mcpServers: {
              "invokta-support": {
                command: "support-engine-mcp",
                args: [],
                disabled,
              },
            },
          }),
        ),
        serverName: "invokta-support",
      });
    const enabled = inspect(false);
    const disabled = inspect(true);
    if (
      enabled.currentServer.kind !== "present" ||
      disabled.currentServer.kind !== "present"
    ) {
      throw new Error("Expected present Antigravity definitions.");
    }
    expect(
      fingerprintNormalizedDefinition(
        enabled.currentServer.definition,
        "native-disabled",
      ),
    ).toBe(
      fingerprintNormalizedDefinition(
        disabled.currentServer.definition,
        "native-disabled",
      ),
    );

    const forged = forgeCurrentServer(enabled, {
      kind: "present",
      definition: Object.freeze({
        ...enabled.currentServer.definition,
        command: "forged-command",
      }),
    });
    const counters = createTargetAdapterCounters();
    expectInstallerCode(
      () =>
        adapter.constructPatch({
          action: "enable",
          inspection: forged,
          counters,
        }),
      "HARNESS_CONFIG_INVALID",
    );
    expect(counters.patchConstructionPasses).toBe(0);
  });

  it("rejects strict JSON, duplicate, raw transport, and semantic boundary violations", () => {
    const adapter = configurationTargetAdapters.antigravity;
    for (const source of [
      "[]",
      '{"mcpServers":null}',
      '{"mcpServers":[]}',
      '{"mcpServers":{"invokta-support":null}}',
      "{mcpServers:{}}",
      '{"mcpServers":{},}',
      '{"mcpServers":{/* comment */}}',
      '{"mcpServers":{},"mcpServers":{}}',
      '{"mcpServers":{},"\\u006dcpServers":{}}',
      '{"unrelated":{"same":1,"same":2},"mcpServers":{}}',
      '{"mcpServers":{"invokta-support":{"command":"one","command":"two"}}}',
      '{"mcpServers":{"invokta-support":{"command":"x","serverUrl":"https://example.com"}}}',
      '{"mcpServers":{"invokta-support":{"disabled":false}}}',
      '{"mcpServers":{"invokta-support":{"command":"x","disabled":"false"}}}',
      '{"mcpServers":{"invokta-support":{"command":"x","transport":"stdio"}}}',
      '{"mcpServers":{"invokta-support":{"command":"x","future":"\\ud800"}}}',
    ]) {
      const counters = createTargetAdapterCounters();
      expectInstallerCode(
        () =>
          adapter.inspect({
            source: encoder.encode(source),
            serverName: "invokta-support",
            counters,
          }),
        "HARNESS_CONFIG_INVALID",
      );
      expect(counters.patchConstructionPasses).toBe(0);
    }

    for (const source of [
      new Uint8Array([0xff]),
      new Uint8Array([0xc3]),
      new Uint8Array([0x80]),
      encoder.encode('{"value":"\ufeff"}'),
      new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
    ]) {
      expectInstallerCode(
        () => adapter.inspect({ source, serverName: "invokta-support" }),
        "HARNESS_CONFIG_INVALID",
      );
    }
  });

  it("enforces global depth, encoded byte boundaries, and exact adapter passes", () => {
    const adapter = configurationTargetAdapters.antigravity;
    const nested = (arrays: number) =>
      encoder.encode(
        `{"future":${"[".repeat(arrays)}null${"]".repeat(arrays)}}`,
      );
    expect(
      adapter.inspect({
        source: nested(99),
        serverName: "invokta-support",
      }).currentServer,
    ).toEqual({ kind: "absent" });
    const tooDeep = createTargetAdapterCounters();
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: nested(100),
          serverName: "invokta-support",
          counters: tooDeep,
        }),
      "HARNESS_CONFIG_INVALID",
    );
    expect(tooDeep.patchConstructionPasses).toBe(0);

    const exact = new Uint8Array(targetConfigByteLimit);
    exact.fill(0x20);
    exact.set(encoder.encode("{}"));
    const sourceCounters = createTargetAdapterCounters();
    expect(
      adapter.inspect({
        source: exact,
        serverName: "invokta-support",
        counters: sourceCounters,
      }).currentServer,
    ).toEqual({ kind: "absent" });
    expect(sourceCounters).toEqual({
      sourceDecodePasses: 1,
      sourceParsePasses: 1,
      inspectionPasses: 1,
      patchConstructionPasses: 0,
      postImageEncodePasses: 0,
      postImageDecodePasses: 0,
      postImageParsePasses: 0,
    });
    const oversizedCounters = createTargetAdapterCounters();
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: new Uint8Array(targetConfigByteLimit + 1),
          serverName: "invokta-support",
          counters: oversizedCounters,
        }),
      "HARNESS_CONFIG_INVALID",
    );
    expect(oversizedCounters.sourceDecodePasses).toBe(0);
    expect(oversizedCounters.sourceParsePasses).toBe(0);

    const counters = createTargetAdapterCounters();
    const definition = adapter.descriptorToDefinition(stdioDescriptor());
    const patch = adapter.constructPatch({
      action: "install",
      definition,
      inspection: adapter.inspect({
        source: encoder.encode('{"mcpServers":{}}'),
        serverName: "invokta-support",
        counters,
      }),
      counters,
    });
    expect(patch.kind).toBe("changed");
    expect(counters).toEqual({
      sourceDecodePasses: 1,
      sourceParsePasses: 1,
      inspectionPasses: 1,
      patchConstructionPasses: 1,
      postImageEncodePasses: 1,
      postImageDecodePasses: 1,
      postImageParsePasses: 1,
    });
  });

  it("counts a leading BOM in the source limit and rejects an oversized post-image before reparsing", () => {
    const adapter = configurationTargetAdapters.antigravity;
    const exactBodyPrefix = '{"padding":"';
    const exactBodySuffix = '"}';
    const exactBody = encoder.encode(
      `${exactBodyPrefix}${"a".repeat(
        targetConfigByteLimit -
          3 -
          exactBodyPrefix.length -
          exactBodySuffix.length,
      )}${exactBodySuffix}`,
    );
    const exactWithBom = new Uint8Array(targetConfigByteLimit);
    exactWithBom.set([0xef, 0xbb, 0xbf]);
    exactWithBom.set(exactBody, 3);
    expect(exactWithBom.byteLength).toBe(targetConfigByteLimit);
    expect(
      adapter.inspect({
        source: exactWithBom,
        serverName: "invokta-support",
      }).currentServer,
    ).toEqual({ kind: "absent" });

    const definition = adapter.descriptorToDefinition(stdioDescriptor());
    const baseSource = encoder.encode('{"padding":"","mcpServers":{}}');
    const basePatch = adapter.constructPatch({
      action: "install",
      definition,
      inspection: adapter.inspect({
        source: baseSource,
        serverName: "invokta-support",
      }),
    });
    expect(basePatch.kind).toBe("changed");
    if (basePatch.kind !== "changed") return;
    const growth = basePatch.postImage.byteLength - baseSource.byteLength;
    const prefix = '{"padding":"';
    const suffix = '","mcpServers":{}}';
    const sourceLength = targetConfigByteLimit + 1 - growth;
    const exactSource = encoder.encode(
      `${prefix}${"a".repeat(
        sourceLength - 1 - prefix.length - suffix.length,
      )}${suffix}`,
    );
    const exactCounters = createTargetAdapterCounters();
    const exactPatch = adapter.constructPatch({
      action: "install",
      definition,
      inspection: adapter.inspect({
        source: exactSource,
        serverName: "invokta-support",
      }),
      counters: exactCounters,
    });
    expect(exactPatch.kind).toBe("changed");
    if (exactPatch.kind !== "changed") return;
    expect(exactPatch.postImage.byteLength).toBe(targetConfigByteLimit);
    expect(exactCounters).toMatchObject({
      patchConstructionPasses: 1,
      postImageEncodePasses: 1,
      postImageDecodePasses: 1,
      postImageParsePasses: 1,
    });

    const source = encoder.encode(
      `${prefix}${"a".repeat(
        sourceLength - prefix.length - suffix.length,
      )}${suffix}`,
    );
    expect(source.byteLength + growth).toBe(targetConfigByteLimit + 1);
    const inspection = adapter.inspect({
      source,
      serverName: "invokta-support",
    });
    const counters = createTargetAdapterCounters();
    expectInstallerCode(
      () =>
        adapter.constructPatch({
          action: "install",
          definition,
          inspection,
          counters,
        }),
      "HARNESS_CONFIG_INVALID",
    );
    expect(counters).toMatchObject({
      patchConstructionPasses: 1,
      postImageEncodePasses: 1,
      postImageDecodePasses: 0,
      postImageParsePasses: 0,
    });
  });
});
