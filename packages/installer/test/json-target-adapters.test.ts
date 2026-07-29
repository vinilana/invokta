import { describe, expect, it } from "vitest";

import { InstallerError } from "../src/installer-error.js";
import { fingerprintNormalizedDefinition } from "../src/jcs-fingerprint.js";
import type { CapabilityInstallDescriptor } from "../src/registry.js";
import { targetConfigByteLimit } from "../src/target-adapter.js";
import {
  configurationTargetAdapters,
  createTargetAdapterCounters,
} from "../src/target-adapters.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function stdioDescriptor(
  forwardEnv: readonly string[] = ["SUPPORT_API_TOKEN"],
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

function httpDescriptor(
  headersFromEnv: Readonly<Record<string, string>> = {
    "X-Support-Tenant": "SUPPORT_TENANT",
  },
): CapabilityInstallDescriptor {
  return {
    ...stdioDescriptor(),
    server: {
      name: "invokta-support",
      transport: {
        type: "streamable-http",
        url: "https://support.example.com/mcp",
        authentication: {
          type: "bearer-env",
          variable: "SUPPORT_API_TOKEN",
        },
        headersFromEnv,
      },
    },
  };
}

function credentialFreeHttpDescriptor(): CapabilityInstallDescriptor {
  const descriptor = httpDescriptor({});
  return {
    ...descriptor,
    server: {
      ...descriptor.server,
      transport: {
        type: "streamable-http",
        url: "https://support.example.com/mcp",
        authentication: { type: "none" },
        headersFromEnv: {},
      },
    },
  };
}

function expectInstallerCode(
  action: () => unknown,
  code: InstallerError["code"],
) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(InstallerError);
    expect((error as InstallerError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
}

describe("strict JSON target adapters", () => {
  it("publishes the exact Claude, Cursor, and Kimi contracts", () => {
    expect(configurationTargetAdapters["claude-code"].metadata).toEqual({
      targetId: "claude-code",
      targetContractVersion: 1,
      format: "json",
      parentPath: ["mcpServers"],
      toggleStrategy: "detached",
    });
    expect(configurationTargetAdapters.cursor.metadata).toEqual({
      targetId: "cursor",
      targetContractVersion: 1,
      format: "json",
      parentPath: ["mcpServers"],
      toggleStrategy: "detached",
    });
    expect(configurationTargetAdapters["kimi-code"].metadata).toEqual({
      targetId: "kimi-code",
      targetContractVersion: 1,
      format: "json",
      parentPath: ["mcpServers"],
      toggleStrategy: "native-enabled",
    });
  });

  it("maps only target-native fields and immutable credential placeholders", () => {
    expect(
      configurationTargetAdapters["claude-code"].descriptorToDefinition(
        stdioDescriptor(),
      ),
    ).toEqual({
      transport: "stdio",
      type: "stdio",
      command: "support-engine-mcp",
      args: ["serve", "--stdio"],
      env: { SUPPORT_API_TOKEN: `\${SUPPORT_API_TOKEN}` },
    });
    expect(
      configurationTargetAdapters.cursor.descriptorToDefinition(
        httpDescriptor(),
      ),
    ).toEqual({
      transport: "streamable-http",
      url: "https://support.example.com/mcp",
      headers: {
        authorization: `Bearer \${env:SUPPORT_API_TOKEN}`,
        "x-support-tenant": `\${env:SUPPORT_TENANT}`,
      },
    });
    expect(
      configurationTargetAdapters["kimi-code"].descriptorToDefinition(
        httpDescriptor({}),
      ),
    ).toEqual({
      transport: "streamable-http",
      url: "https://support.example.com/mcp",
      bearerTokenEnvVar: "SUPPORT_API_TOKEN",
      enabled: true,
    });
    expect(
      configurationTargetAdapters["kimi-code"].descriptorToDefinition(
        stdioDescriptor([]),
      ),
    ).toEqual({
      transport: "stdio",
      command: "support-engine-mcp",
      args: ["serve", "--stdio"],
      enabled: true,
    });
    expect(
      Object.getOwnPropertySymbols(
        configurationTargetAdapters.cursor.descriptorToDefinition(
          stdioDescriptor(),
        ),
      ),
    ).toEqual([]);
  });

  it("writes Claude Desktop and VS Code user-config shapes with native environment placeholders", () => {
    const claudeDesktop = configurationTargetAdapters["claude-desktop"];
    const claudePatch = claudeDesktop.constructPatch({
      action: "install",
      definition: claudeDesktop.descriptorToDefinition(stdioDescriptor()),
      inspection: claudeDesktop.inspect({
        source: undefined,
        serverName: "invokta-support",
      }),
    });
    expect(claudePatch.kind).toBe("changed");
    if (claudePatch.kind !== "changed") return;
    expect(JSON.parse(decoder.decode(claudePatch.postImage))).toEqual({
      mcpServers: {
        "invokta-support": {
          type: "stdio",
          command: "support-engine-mcp",
          args: ["serve", "--stdio"],
          env: { SUPPORT_API_TOKEN: `\${SUPPORT_API_TOKEN}` },
        },
      },
    });

    const vscode = configurationTargetAdapters.vscode;
    expect(vscode.descriptorToDefinition(stdioDescriptor())).toEqual({
      transport: "stdio",
      type: "stdio",
      command: "support-engine-mcp",
      args: ["serve", "--stdio"],
      env: { SUPPORT_API_TOKEN: `\${env:SUPPORT_API_TOKEN}` },
    });
    expect(vscode.descriptorToDefinition(httpDescriptor())).toEqual({
      transport: "streamable-http",
      type: "http",
      url: "https://support.example.com/mcp",
      headers: {
        authorization: `Bearer \${env:SUPPORT_API_TOKEN}`,
        "x-support-tenant": `\${env:SUPPORT_TENANT}`,
      },
    });

    const vscodePatch = vscode.constructPatch({
      action: "install",
      definition: vscode.descriptorToDefinition(stdioDescriptor()),
      inspection: vscode.inspect({
        source: encoder.encode(
          '{\n  // keep profile settings\n  "inputs": [],\n  "servers": {\n    "other": { "type": "stdio", "command": "other", },\n  },\n}\n',
        ),
        serverName: "invokta-support",
      }),
    });
    expect(vscodePatch.kind).toBe("changed");
    if (vscodePatch.kind !== "changed") return;
    const vscodeText = decoder.decode(vscodePatch.postImage);
    expect(vscodeText).toContain("// keep profile settings");
    expect(vscodeText).toContain('"other": { "type": "stdio"');
    expect(vscodeText).toContain('"invokta-support":');
    expect(vscodeText).toContain(
      `"SUPPORT_API_TOKEN":"\${env:SUPPORT_API_TOKEN}"`,
    );
  });

  it.each(["claude-code", "cursor"] as const)(
    "installs, detaches, and exactly restores %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const definition = adapter.descriptorToDefinition(stdioDescriptor());
      const empty = adapter.inspect({
        source: encoder.encode(
          '{"projects":{"p":{"disabledMcpServers":["keep"],"enabledMcpServers":["also-keep"]}},"mcpServers":{}}\n',
        ),
        serverName: "invokta-support",
      });
      const installed = adapter.constructPatch({
        action: "install",
        definition,
        inspection: empty,
      });
      expect(installed.kind).toBe("changed");
      if (installed.kind !== "changed") return;
      const installedText = decoder.decode(installed.postImage);
      expect(installedText).not.toContain('"transport"');
      expect(installedText).toContain('"command":"support-engine-mcp"');
      expect(installedText).toContain('"disabledMcpServers":["keep"]');

      const present = adapter.inspect({
        source: installed.postImage,
        serverName: "invokta-support",
      });
      const disabled = adapter.constructPatch({
        action: "disable",
        inspection: present,
      });
      expect(disabled.kind).toBe("changed");
      if (disabled.kind !== "changed") return;
      expect(decoder.decode(disabled.postImage)).toContain('"mcpServers":{}');

      const absent = adapter.inspect({
        source: disabled.postImage,
        serverName: "invokta-support",
      });
      const enabled = adapter.constructPatch({
        action: "enable",
        restoreDefinition: definition,
        inspection: absent,
      });
      expect(enabled).toEqual(installed);
    },
  );

  it("normalizes Claude type aliases without normalizing unrelated fields", () => {
    const adapter = configurationTargetAdapters["claude-code"];
    const stdio = (type: string | undefined) =>
      adapter.inspect({
        source: encoder.encode(
          JSON.stringify({
            mcpServers: {
              "invokta-support": {
                ...(type === undefined ? {} : { type }),
                command: "support-engine-mcp",
                future: { visible: true },
              },
            },
          }),
        ),
        serverName: "invokta-support",
      });
    expect(stdio(undefined).currentServer).toEqual(
      stdio("stdio").currentServer,
    );
    expect(
      adapter.inspect({
        source: encoder.encode(
          '{"mcpServers":{"invokta-support":{"type":"streamable-http","url":"https://support.example.com/mcp"}}}',
        ),
        serverName: "invokta-support",
      }).currentServer,
    ).toEqual(
      adapter.inspect({
        source: encoder.encode(
          '{"mcpServers":{"invokta-support":{"type":"http","url":"https://support.example.com/mcp"}}}',
        ),
        serverName: "invokta-support",
      }).currentServer,
    );
    expectInstallerCode(() => stdio("http"), "HARNESS_CONFIG_INVALID");
  });

  it("uses one strict parse and one integrated inspection per image", () => {
    const adapter = configurationTargetAdapters["kimi-code"];
    const counters = createTargetAdapterCounters();
    const inspection = adapter.inspect({
      source: encoder.encode('{"mcpServers":{}}'),
      serverName: "invokta-support",
      counters,
    });
    const patch = adapter.constructPatch({
      action: "install",
      definition: adapter.descriptorToDefinition(stdioDescriptor([])),
      inspection,
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

  it("rejects duplicates, JSON5, raw transport, header collisions, and stale restores", () => {
    for (const targetId of ["claude-code", "cursor", "kimi-code"] as const) {
      const adapter = configurationTargetAdapters[targetId];
      for (const source of [
        '{"mcpServers":{},"mcpServers":{}}',
        "{mcpServers:{}}",
        '{"mcpServers":{},}',
        '{"mcpServers":{/* comment */}}',
        '{"mcpServers":{"invokta-support":{"command":"x","transport":"stdio"}}}',
        '{"mcpServers":{"invokta-support":{"url":"x","headers":{"X-A":"1","x-a":"2"}}}}',
      ]) {
        expectInstallerCode(
          () =>
            adapter.inspect({
              source: encoder.encode(source),
              serverName: "invokta-support",
            }),
          "HARNESS_CONFIG_INVALID",
        );
      }
    }

    const cursor = configurationTargetAdapters.cursor;
    const inspection = cursor.inspect({
      source: encoder.encode(
        '{"mcpServers":{"invokta-support":{"command":"different"}}}',
      ),
      serverName: "invokta-support",
    });
    expectInstallerCode(
      () =>
        cursor.constructPatch({
          action: "enable",
          restoreDefinition: cursor.descriptorToDefinition(stdioDescriptor()),
          inspection,
        }),
      "CONFIG_CONFLICT",
    );
  });

  it("normalizes selected HTTP header casing during inspection", () => {
    const adapter = configurationTargetAdapters.cursor;
    const inspect = (header: string) =>
      adapter.inspect({
        source: encoder.encode(
          JSON.stringify({
            mcpServers: {
              "invokta-support": {
                url: "https://support.example.com/mcp",
                headers: { [header]: `Bearer \${env:SUPPORT_API_TOKEN}` },
              },
            },
          }),
        ),
        serverName: "invokta-support",
      }).currentServer;
    const titleCase = inspect("Authorization");
    const lowerCase = inspect("authorization");
    expect(titleCase).toEqual(lowerCase);
    if (titleCase.kind !== "present" || lowerCase.kind !== "present") return;
    expect(
      fingerprintNormalizedDefinition(titleCase.definition, "detached"),
    ).toBe(fingerprintNormalizedDefinition(lowerCase.definition, "detached"));
    expect(inspect("AUTHORIZATION")).toEqual({
      kind: "present",
      definition: {
        transport: "streamable-http",
        url: "https://support.example.com/mcp",
        headers: {
          authorization: `Bearer \${env:SUPPORT_API_TOKEN}`,
        },
      },
    });
  });

  it("requires a normalized dialect-matching restore and keeps absent disable idempotent", () => {
    const cursor = configurationTargetAdapters.cursor;
    const absent = cursor.inspect({
      source: encoder.encode('{"mcpServers":{}}'),
      serverName: "invokta-support",
    });
    const counters = createTargetAdapterCounters();
    expect(
      cursor.constructPatch({
        action: "disable",
        inspection: absent,
        counters,
      }),
    ).toEqual({
      kind: "unchanged",
    });
    expect(counters.patchConstructionPasses).toBe(0);
    expectInstallerCode(
      () => cursor.constructPatch({ action: "enable", inspection: absent }),
      "HARNESS_CONFIG_INVALID",
    );
    expectInstallerCode(
      () =>
        cursor.constructPatch({
          action: "enable",
          inspection: absent,
          restoreDefinition: configurationTargetAdapters[
            "claude-code"
          ].descriptorToDefinition(stdioDescriptor()),
        }),
      "HARNESS_CONFIG_INVALID",
    );

    const wrongDialectInspection = configurationTargetAdapters[
      "claude-code"
    ].inspect({
      source: encoder.encode('{"mcpServers":{}}'),
      serverName: "invokta-support",
    });
    expectInstallerCode(
      () =>
        cursor.constructPatch({
          action: "disable",
          inspection: wrongDialectInspection,
        }),
      "HARNESS_CONFIG_INVALID",
    );

    const claude = configurationTargetAdapters["claude-code"];
    const claudeAbsent = claude.inspect({
      source: encoder.encode('{"mcpServers":{}}'),
      serverName: "invokta-support",
    });
    expectInstallerCode(
      () =>
        claude.constructPatch({
          action: "enable",
          inspection: claudeAbsent,
          restoreDefinition: {
            transport: "streamable-http",
            type: "streamable-http",
            url: "https://support.example.com/mcp",
            headers: {},
          },
        }),
      "HARNESS_CONFIG_INVALID",
    );
  });

  it.each(["claude-code", "cursor"] as const)(
    "rejects invalid detached HTTP header semantics for %s before patching",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const absent = adapter.inspect({
        source: encoder.encode('{"mcpServers":{}}'),
        serverName: "invokta-support",
      });
      const definition = adapter.descriptorToDefinition(httpDescriptor());
      const bare =
        targetId === "cursor"
          ? `\${env:SUPPORT_API_TOKEN}`
          : `\${SUPPORT_API_TOKEN}`;
      const bearer = `Bearer ${bare}`;
      for (const headers of [
        { "x-api-key": bearer },
        { "bad header": bare },
        { host: bare },
      ]) {
        const counters = createTargetAdapterCounters();
        expectInstallerCode(
          () =>
            adapter.constructPatch({
              action: "enable",
              inspection: absent,
              restoreDefinition: { ...definition, headers },
              counters,
            }),
          "HARNESS_CONFIG_INVALID",
        );
        expect(counters.patchConstructionPasses).toBe(0);
      }

      const valid = adapter.constructPatch({
        action: "enable",
        inspection: absent,
        restoreDefinition: definition,
      });
      expect(valid.kind).toBe("changed");
      const bareAuthorization = adapter.constructPatch({
        action: "enable",
        inspection: absent,
        restoreDefinition: { ...definition, headers: { authorization: bare } },
      });
      expect(bareAuthorization.kind).toBe("changed");
    },
  );

  it("enforces Kimi transport limits and native enabled toggles", () => {
    const adapter = configurationTargetAdapters["kimi-code"];
    expect(adapter.compatibility(stdioDescriptor(["TOKEN"]))).toEqual({
      supported: false,
      reason: "kimi-code-forward-env-unsupported",
    });
    expect(adapter.compatibility(httpDescriptor({ "X-A": "TOKEN" }))).toEqual({
      supported: false,
      reason: "kimi-code-http-headers-unsupported",
    });
    const source = encoder.encode(
      '{"mcpServers":{"invokta-support":{"command":"support-engine-mcp","enabled":true}}}',
    );
    const inspection = adapter.inspect({
      source,
      serverName: "invokta-support",
    });
    const disabled = adapter.constructPatch({
      action: "disable",
      inspection,
    });
    expect(disabled.kind).toBe("changed");
    if (disabled.kind !== "changed") return;
    expect(decoder.decode(disabled.postImage)).toContain('"enabled":false');
  });

  it("writes exact Kimi stdio, bearer HTTP, and credential-free HTTP shapes", () => {
    const adapter = configurationTargetAdapters["kimi-code"];
    for (const [descriptor, expected] of [
      [
        stdioDescriptor([]),
        {
          command: "support-engine-mcp",
          args: ["serve", "--stdio"],
          enabled: true,
        },
      ],
      [
        httpDescriptor({}),
        {
          url: "https://support.example.com/mcp",
          bearerTokenEnvVar: "SUPPORT_API_TOKEN",
          enabled: true,
        },
      ],
      [
        credentialFreeHttpDescriptor(),
        { url: "https://support.example.com/mcp", enabled: true },
      ],
    ] as const) {
      const inspection = adapter.inspect({
        source: undefined,
        serverName: descriptor.server.name,
      });
      const patch = adapter.constructPatch({
        action: "install",
        definition: adapter.descriptorToDefinition(descriptor),
        inspection,
      });
      expect(patch.kind).toBe("changed");
      if (patch.kind !== "changed") continue;
      expect(decoder.decode(patch.postImage).endsWith("\n")).toBe(true);
      expect(JSON.parse(decoder.decode(patch.postImage))).toEqual({
        mcpServers: { "invokta-support": expected },
      });
    }
  });

  it("preserves BOM, CRLF, trailing-newline policy, and unrelated Claude project bytes", () => {
    const adapter = configurationTargetAdapters["claude-code"];
    const body =
      '{\r\n  "projects": {"p":{"disabledMcpServers":["keep"],"enabledMcpServers":["keep-too"]}},\r\n  "enabledMcpjsonServers": ["global"],\r\n  "disabledMcpjsonServers": ["other"],\r\n  "mcpServers": {}\r\n}';
    const payload = encoder.encode(body);
    const source = new Uint8Array(payload.length + 3);
    source.set([0xef, 0xbb, 0xbf]);
    source.set(payload, 3);
    const inspection = adapter.inspect({
      source,
      serverName: "invokta-support",
    });
    const patch = adapter.constructPatch({
      action: "install",
      definition: adapter.descriptorToDefinition(stdioDescriptor()),
      inspection,
    });
    expect(patch.kind).toBe("changed");
    if (patch.kind !== "changed") return;
    expect([...patch.postImage.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const postText = decoder.decode(patch.postImage);
    expect(postText).toContain("\r\n");
    expect(postText.endsWith("\n")).toBe(false);
    for (const exact of [
      '"projects": {"p":{"disabledMcpServers":["keep"],"enabledMcpServers":["keep-too"]}}',
      '"enabledMcpjsonServers": ["global"]',
      '"disabledMcpjsonServers": ["other"]',
    ]) {
      expect(postText).toContain(exact);
    }
  });

  it("preserves unknown selected fields in the normalized fingerprint-visible definition", () => {
    const current = configurationTargetAdapters.cursor.inspect({
      source: encoder.encode(
        '{"mcpServers":{"invokta-support":{"command":"support-engine-mcp","future":{"nested":[1,true,null]}}}}',
      ),
      serverName: "invokta-support",
    }).currentServer;
    expect(current).toEqual({
      kind: "present",
      definition: {
        command: "support-engine-mcp",
        args: [],
        env: {},
        future: { nested: [1, true, null] },
        transport: "stdio",
      },
    });
    if (current.kind !== "present") return;
    expect(Object.isFrozen(current.definition)).toBe(true);
    expect(Object.isFrozen(current.definition.future)).toBe(true);
  });

  it("removes detached entries safely in first, middle, last, and only-member positions", () => {
    const adapter = configurationTargetAdapters.cursor;
    for (const [source, remaining] of [
      [
        '{"mcpServers":{"invokta-support":{"command":"x"},"b":{"command":"b"}}}',
        ["b"],
      ],
      [
        '{"mcpServers":{"a":{"command":"a"},"invokta-support":{"command":"x"},"b":{"command":"b"}}}',
        ["a", "b"],
      ],
      [
        '{"mcpServers":{"a":{"command":"a"},"invokta-support":{"command":"x"}}}',
        ["a"],
      ],
      ['{"mcpServers":{"invokta-support":{"command":"x"}}}', []],
    ] as const) {
      const inspection = adapter.inspect({
        source: encoder.encode(source),
        serverName: "invokta-support",
      });
      const patch = adapter.constructPatch({ action: "disable", inspection });
      expect(patch.kind).toBe("changed");
      if (patch.kind !== "changed") continue;
      const parsed = JSON.parse(decoder.decode(patch.postImage)) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(parsed.mcpServers)).toEqual(remaining);
    }
  });

  it("enforces strict UTF-8, the byte ceiling, and one post-image ceiling check", () => {
    const adapter = configurationTargetAdapters.cursor;
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: new Uint8Array([0xff]),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: new Uint8Array(targetConfigByteLimit + 1),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );

    const exactPrefix = '{"padding":"';
    const exactSuffix = '"}';
    const exactLimit = encoder.encode(
      `${exactPrefix}${"a".repeat(
        targetConfigByteLimit - exactPrefix.length - exactSuffix.length,
      )}${exactSuffix}`,
    );
    expect(exactLimit.byteLength).toBe(targetConfigByteLimit);
    expect(
      adapter.inspect({
        source: exactLimit,
        serverName: "invokta-support",
      }).currentServer,
    ).toEqual({ kind: "absent" });

    const definition = adapter.descriptorToDefinition(stdioDescriptor());
    const baseSource = encoder.encode('{"padding":"","mcpServers":{}}');
    const baseInspection = adapter.inspect({
      source: baseSource,
      serverName: "invokta-support",
    });
    const basePatch = adapter.constructPatch({
      action: "install",
      definition,
      inspection: baseInspection,
    });
    expect(basePatch.kind).toBe("changed");
    if (basePatch.kind !== "changed") return;
    const patchGrowth = basePatch.postImage.byteLength - baseSource.byteLength;
    const prefix = '{"padding":"';
    const suffix = '","mcpServers":{}}';
    const sourceLength = targetConfigByteLimit + 1 - patchGrowth;
    const atLimitAfterPatch = encoder.encode(
      `${prefix}${"a".repeat(sourceLength - prefix.length - suffix.length)}${suffix}`,
    );
    expect(atLimitAfterPatch.byteLength + patchGrowth).toBe(
      targetConfigByteLimit + 1,
    );
    const inspection = adapter.inspect({
      source: atLimitAfterPatch,
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

  it("accepts aggregate depth 100 and rejects 101 plus duplicates outside the selected path", () => {
    const adapter = configurationTargetAdapters.cursor;
    const nested = (arrays: number) =>
      `{"future":${"[".repeat(arrays)}null${"]".repeat(arrays)}}`;
    expect(
      adapter.inspect({
        source: encoder.encode(nested(99)),
        serverName: "invokta-support",
      }).currentServer,
    ).toEqual({ kind: "absent" });
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: encoder.encode(nested(100)),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: encoder.encode(
            '{"unrelated":{"duplicate":1,"duplicate":2},"mcpServers":{}}',
          ),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
  });
});
