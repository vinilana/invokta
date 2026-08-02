import { describe, expect, it, vi } from "vitest";

import { InstallerError } from "../src/installer-error.js";
import type { CapabilityInstallDescriptor } from "../src/registry.js";
import { targetInspectionState } from "../src/target-adapter.js";
import {
  configurationTargetAdapters,
  createTargetAdapterCounters,
  openClawDeniedEnvironmentNameSnapshot,
  openClawEnvironmentPolicyCommit,
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

function httpDescriptor(): CapabilityInstallDescriptor {
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
        headersFromEnv: {
          "X-Support-Tenant": "SUPPORT_TENANT",
        },
      },
    },
  };
}

function credentialFreeHttpDescriptor(): CapabilityInstallDescriptor {
  const descriptor = httpDescriptor();
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

function install(
  targetId: "codex" | "hermes" | "openclaw",
  descriptor: CapabilityInstallDescriptor,
): Uint8Array {
  const adapter = configurationTargetAdapters[targetId];
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
  if (patch.kind !== "changed") throw new Error("Expected a changed patch.");
  return patch.postImage;
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

function forgeCurrentServer<T extends { readonly currentServer: unknown }>(
  inspection: T,
  currentServer: unknown,
): T {
  const forged = { currentServer } as unknown as T;
  for (const symbol of Object.getOwnPropertySymbols(inspection)) {
    Object.defineProperty(forged, symbol, {
      configurable: false,
      enumerable: false,
      value: Reflect.get(inspection, symbol),
      writable: false,
    });
  }
  return forged;
}

function unrelatedSource(format: string, value: "attacker" | "original") {
  if (format === "toml") return encoder.encode(`title = "${value}"\n`);
  if (format === "yaml") return encoder.encode(`title: ${value}\n`);
  return encoder.encode(`{"title":"${value}"}\n`);
}

describe("first native-toggle target adapters", () => {
  it("publishes exact immutable metadata and deterministic placeholders", () => {
    expect(
      Object.fromEntries(
        Object.entries(configurationTargetAdapters).map(([id, adapter]) => [
          id,
          adapter.metadata,
        ]),
      ),
    ).toEqual({
      antigravity: {
        targetId: "antigravity",
        targetContractVersion: 1,
        format: "json",
        parentPath: ["mcpServers"],
        toggleStrategy: "native-disabled",
      },
      "claude-code": {
        targetId: "claude-code",
        targetContractVersion: 1,
        format: "json",
        parentPath: ["mcpServers"],
        toggleStrategy: "detached",
      },
      "claude-desktop": {
        targetId: "claude-desktop",
        targetContractVersion: 1,
        format: "json",
        parentPath: ["mcpServers"],
        toggleStrategy: "detached",
      },
      codex: {
        targetId: "codex",
        targetContractVersion: 1,
        format: "toml",
        parentPath: ["mcp_servers"],
        toggleStrategy: "native-enabled",
      },
      cursor: {
        targetId: "cursor",
        targetContractVersion: 1,
        format: "json",
        parentPath: ["mcpServers"],
        toggleStrategy: "detached",
      },
      "grok-build": {
        targetId: "grok-build",
        targetContractVersion: 1,
        format: "toml",
        parentPath: ["mcp_servers"],
        toggleStrategy: "native-enabled",
      },
      hermes: {
        targetId: "hermes",
        targetContractVersion: 1,
        format: "yaml",
        parentPath: ["mcp_servers"],
        toggleStrategy: "native-enabled",
      },
      "kimi-code": {
        targetId: "kimi-code",
        targetContractVersion: 1,
        format: "json",
        parentPath: ["mcpServers"],
        toggleStrategy: "native-enabled",
      },
      openclaw: {
        targetId: "openclaw",
        targetContractVersion: 1,
        format: "json5",
        parentPath: ["mcp", "servers"],
        toggleStrategy: "native-enabled",
      },
      "opencode-v2": {
        targetId: "opencode-v2",
        targetContractVersion: 1,
        format: "jsonc",
        parentPath: ["mcp", "servers"],
        toggleStrategy: "native-disabled",
      },
      vscode: {
        targetId: "vscode",
        targetContractVersion: 1,
        format: "jsonc",
        parentPath: ["servers"],
        toggleStrategy: "detached",
      },
    });
    expect(Object.isFrozen(configurationTargetAdapters.codex.metadata)).toBe(
      true,
    );
  });

  it("keeps all adapter parse state private from visible inspection symbols", () => {
    const descriptor = stdioDescriptor([]);
    for (const adapter of Object.values(configurationTargetAdapters)) {
      const inspection = adapter.inspect({
        source: unrelatedSource(adapter.metadata.format, "original"),
        serverName: descriptor.server.name,
      });
      const exposed = inspection[targetInspectionState];
      expect(typeof exposed).toBe("object");
      expect(exposed).not.toBeNull();
      if (typeof exposed === "object" && exposed !== null) {
        const visibleSource = Reflect.get(exposed, "source") as unknown;
        if (typeof visibleSource === "object" && visibleSource !== null) {
          Reflect.set(
            visibleSource,
            "text",
            decoder.decode(
              unrelatedSource(adapter.metadata.format, "attacker"),
            ),
          );
        } else {
          Reflect.set(exposed, "source", { text: "attacker" });
        }
      }

      const patch = adapter.constructPatch({
        action: "install",
        definition: adapter.descriptorToDefinition(descriptor),
        inspection,
      });
      expect(patch.kind).toBe("changed");
      if (patch.kind !== "changed") throw new Error("Expected changed patch.");
      const postImage = decoder.decode(patch.postImage);
      expect(postImage).toContain("original");
      expect(postImage).not.toContain("attacker");
    }
  });

  it("rejects inspection copies even when every visible symbol is copied", () => {
    const descriptor = stdioDescriptor([]);
    for (const adapter of Object.values(configurationTargetAdapters)) {
      const inspection = adapter.inspect({
        source: undefined,
        serverName: descriptor.server.name,
      });
      const copied = Object.create(
        Object.getPrototypeOf(inspection),
        Object.getOwnPropertyDescriptors(inspection),
      ) as typeof inspection;
      expectInstallerCode(
        () =>
          adapter.constructPatch({
            action: "install",
            definition: adapter.descriptorToDefinition(descriptor),
            inspection: copied,
          }),
        "HARNESS_CONFIG_INVALID",
      );
    }
  });

  it("rejects genuine inspections created by a different adapter", () => {
    const descriptor = stdioDescriptor([]);
    const adapters = Object.values(configurationTargetAdapters);
    const inspections = adapters.map((adapter) =>
      adapter.inspect({
        source: undefined,
        serverName: descriptor.server.name,
      }),
    );
    for (const [index, adapter] of adapters.entries()) {
      const foreignInspection = inspections[(index + 1) % inspections.length];
      if (foreignInspection === undefined) {
        throw new Error("Expected a foreign inspection.");
      }
      expectInstallerCode(
        () =>
          adapter.constructPatch({
            action: "install",
            definition: adapter.descriptorToDefinition(descriptor),
            inspection: foreignInspection,
          }),
        "HARNESS_CONFIG_INVALID",
      );
    }
  });

  it.each(["codex", "hermes", "openclaw"] as const)(
    "maps and round-trips stdio definitions for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const descriptor = stdioDescriptor();
      expect(adapter.compatibility(descriptor)).toEqual({ supported: true });

      const definition = adapter.descriptorToDefinition(descriptor);
      expect(definition).toEqual(
        targetId === "codex"
          ? {
              transport: "stdio",
              command: "support-engine-mcp",
              args: ["serve", "--stdio"],
              env_vars: ["SUPPORT_API_TOKEN"],
              enabled: true,
            }
          : {
              transport: "stdio",
              command: "support-engine-mcp",
              args: ["serve", "--stdio"],
              env: { SUPPORT_API_TOKEN: `\${SUPPORT_API_TOKEN}` },
              enabled: true,
            },
      );

      const postImage = install(targetId, descriptor);
      expect(decoder.decode(postImage).endsWith("\n")).toBe(true);
      expect(
        adapter.inspect({
          source: postImage,
          serverName: descriptor.server.name,
        }).currentServer,
      ).toEqual({ kind: "present", definition });
    },
  );

  it.each([
    {
      targetId: "codex" as const,
      source: (transport: string) =>
        `[mcp_servers.invokta-support]\ncommand = "support-engine-mcp"\ntransport = "${transport}"\nfuture_field = "preserved"\n`,
    },
    {
      targetId: "hermes" as const,
      source: (transport: string) =>
        `mcp_servers:\n  invokta-support:\n    command: support-engine-mcp\n    transport: ${transport}\n    future_field: preserved\n`,
    },
    {
      targetId: "openclaw" as const,
      source: (transport: string) =>
        `{mcp:{servers:{"invokta-support":{command:"support-engine-mcp",transport:"${transport}",future_field:"preserved"}}}}`,
    },
  ])(
    "rejects raw selected-entry stdio transport fields for $targetId without collapsing them into the canonical transport",
    ({ targetId, source }) => {
      const adapter = configurationTargetAdapters[targetId];
      for (const transport of ["stdio", "future-transport"]) {
        expectInstallerCode(
          () =>
            adapter.inspect({
              source: encoder.encode(source(transport)),
              serverName: "invokta-support",
            }),
          "HARNESS_CONFIG_INVALID",
        );
      }
    },
  );

  it("accepts only the exact documented OpenClaw HTTP transport and preserves unrelated unknown fields", () => {
    const adapter = configurationTargetAdapters.openclaw;
    const source = (transport: string) =>
      encoder.encode(
        `{mcp:{servers:{"invokta-support":{url:"https://support.example.com/mcp",transport:"${transport}",future_field:{nested:"preserved"}}}}}`,
      );
    const current = adapter.inspect({
      source: source("streamable-http"),
      serverName: "invokta-support",
    }).currentServer;
    expect(current).toEqual({
      kind: "present",
      definition: {
        url: "https://support.example.com/mcp",
        transport: "streamable-http",
        future_field: { nested: "preserved" },
        headers: {},
        enabled: true,
      },
    });
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: source("stdio"),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
  });

  it.each(["codex", "hermes", "openclaw"] as const)(
    "keeps inspection internals opaque and rejects forged current servers before branching for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const descriptor = stdioDescriptor([]);
      const installedInspection = adapter.inspect({
        source: install(targetId, descriptor),
        serverName: descriptor.server.name,
      });
      expect(Object.getOwnPropertySymbols(installedInspection)).toHaveLength(2);
      for (const symbol of Object.getOwnPropertySymbols(installedInspection)) {
        expect(
          Object.getOwnPropertyDescriptor(installedInspection, symbol)
            ?.enumerable,
        ).toBe(false);
      }
      expect(
        Object.getOwnPropertySymbols({ ...installedInspection }),
      ).toHaveLength(0);

      if (installedInspection.currentServer.kind !== "present") {
        throw new Error("Expected an installed server.");
      }
      const forgedEnabled = forgeCurrentServer(installedInspection, {
        kind: "present",
        definition: {
          ...installedInspection.currentServer.definition,
          command: "forged-command",
          enabled: true,
        },
      });
      for (const action of ["enable", "disable"] as const) {
        const counters = createTargetAdapterCounters();
        expectInstallerCode(
          () =>
            adapter.constructPatch({
              action,
              inspection: forgedEnabled,
              counters,
            }),
          "HARNESS_CONFIG_INVALID",
        );
        expect(counters.patchConstructionPasses).toBe(0);
      }

      const absentInspection = adapter.inspect({
        source: undefined,
        serverName: descriptor.server.name,
      });
      const forgedPresent = forgeCurrentServer(absentInspection, {
        kind: "present",
        definition: adapter.descriptorToDefinition(descriptor),
      });
      expectInstallerCode(
        () =>
          adapter.constructPatch({
            action: "install",
            definition: adapter.descriptorToDefinition(descriptor),
            inspection: forgedPresent,
          }),
        "HARNESS_CONFIG_INVALID",
      );

      const counters = createTargetAdapterCounters();
      const forgedAbsent = forgeCurrentServer(installedInspection, {
        kind: "absent",
      });
      expectInstallerCode(
        () =>
          adapter.constructPatch({
            action: "install",
            definition: adapter.descriptorToDefinition(descriptor),
            inspection: forgedAbsent,
            counters,
          }),
        "HARNESS_CONFIG_INVALID",
      );
      expect(counters.patchConstructionPasses).toBe(0);
    },
  );

  it("patches the semantic TOML enabled key, never marker text in strings or comments", () => {
    const adapter = configurationTargetAdapters.codex;
    const source = encoder.encode(
      [
        "# [mcp_servers.invokta-support]",
        'ordinary = "[mcp_servers.invokta-support] enabled = false"',
        "[mcp_servers.invokta-support]",
        'command = "support-engine-mcp"',
        "args = []",
        'note = """',
        "enabled = false",
        'env_http_headers.fake = "INSIDE_STRING"',
        '"""',
        "enabled = false",
        "",
      ].join("\n"),
    );
    const patch = adapter.constructPatch({
      action: "enable",
      inspection: adapter.inspect({
        source,
        serverName: "invokta-support",
      }),
    });
    expect(patch.kind).toBe("changed");
    if (patch.kind !== "changed") throw new Error("Expected change.");
    const postText = decoder.decode(patch.postImage);
    expect(postText).toContain(
      'note = """\nenabled = false\nenv_http_headers.fake = "INSIDE_STRING"\n"""',
    );
    const current = adapter.inspect({
      source: patch.postImage,
      serverName: "invokta-support",
    }).currentServer;
    expect(current.kind).toBe("present");
    if (current.kind !== "present") throw new Error("Expected server.");
    expect(current.definition.enabled).toBe(true);
  });

  it("treats an enabled TOML server with multiline marker text as a semantic no-op", () => {
    const adapter = configurationTargetAdapters.codex;
    const source = encoder.encode(
      [
        "[mcp_servers.invokta-support]",
        'command = "support-engine-mcp"',
        "args = []",
        'note = """enabled = false"""',
        "enabled = true",
        "",
      ].join("\n"),
    );
    const counters = createTargetAdapterCounters();
    const patch = adapter.constructPatch({
      action: "enable",
      inspection: adapter.inspect({
        source,
        serverName: "invokta-support",
        counters,
      }),
      counters,
    });

    expect(patch).toEqual({ kind: "unchanged" });
    expect(counters.patchConstructionPasses).toBe(0);
    expect(counters.postImageParsePasses).toBe(0);
  });

  it("enforces semantic depth for TOML dotted and inline-dotted keys", () => {
    const adapter = configurationTargetAdapters.codex;
    const dotted = (segments: number) =>
      encoder.encode(
        `${Array.from({ length: segments }, () => "a").join(".")} = 0\n`,
      );
    const inlineDotted = (segments: number) =>
      encoder.encode(
        `value = { ${Array.from({ length: segments }, () => "a").join(".")} = 0 }\n`,
      );

    for (const source of [dotted(100), inlineDotted(99)]) {
      expect(
        adapter.inspect({ source, serverName: "invokta-support" })
          .currentServer,
      ).toEqual({ kind: "absent" });
    }
    for (const source of [
      dotted(101),
      dotted(1_000),
      inlineDotted(100),
      inlineDotted(1_000),
    ]) {
      expectInstallerCode(
        () => adapter.inspect({ source, serverName: "invokta-support" }),
        "HARNESS_CONFIG_INVALID",
      );
    }
  });

  it("counts TOML arrays of tables by semantic container depth", () => {
    const adapter = configurationTargetAdapters.codex;
    const arrayOfTables = (segments: number) =>
      encoder.encode(
        `[[${Array.from({ length: segments }, (_, index) => `level_${index}`).join(".")}]]\nvalue = 0\n`,
      );

    expect(
      adapter.inspect({
        source: arrayOfTables(98),
        serverName: "invokta-support",
      }).currentServer,
    ).toEqual({ kind: "absent" });
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: arrayOfTables(99),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
  });

  it.each([
    {
      name: "explicit table",
      source:
        '[mcp_servers.invokta-support]\ncommand = "support-engine-mcp"\nargs = []\nenabled = false\n',
    },
    {
      name: "dotted keys",
      source:
        'mcp_servers.invokta-support.command = "support-engine-mcp"\nmcp_servers.invokta-support.args = []\nmcp_servers.invokta-support.enabled = false\n',
    },
    {
      name: "inline table",
      source:
        'mcp_servers = { invokta-support = { command = "support-engine-mcp", args = [], enabled = false }, other = { command = "old", args = [] } }\n',
    },
  ])("toggles a TOML $name representation locally", ({ source }) => {
    const adapter = configurationTargetAdapters.codex;
    const before = encoder.encode(source);
    const patch = adapter.constructPatch({
      action: "enable",
      inspection: adapter.inspect({
        source: before,
        serverName: "invokta-support",
      }),
    });
    expect(patch.kind).toBe("changed");
    if (patch.kind !== "changed") throw new Error("Expected change.");
    const current = adapter.inspect({
      source: patch.postImage,
      serverName: "invokta-support",
    }).currentServer;
    expect(current.kind).toBe("present");
    if (current.kind !== "present") throw new Error("Expected server.");
    expect(current.definition.enabled).toBe(true);
    expect(decoder.decode(patch.postImage)).toContain("command");
  });

  it.each([
    { source: "mcp_servers = {}\n", preserved: "mcp_servers = {" },
    {
      source:
        'mcp_servers = { other = { command = "old", args = [] } }\ntheme = "dark"\n',
      preserved: 'other = { command = "old", args = [] }',
    },
    {
      source:
        'mcp_servers.other.command = "old"\nmcp_servers.other.args = []\ntheme = "dark"\n',
      preserved: 'mcp_servers.other.command = "old"',
    },
  ])(
    "installs into valid TOML parent forms without conflicting append: $source",
    ({ source, preserved }) => {
      const adapter = configurationTargetAdapters.codex;
      const descriptor = stdioDescriptor([]);
      const patch = adapter.constructPatch({
        action: "install",
        definition: adapter.descriptorToDefinition(descriptor),
        inspection: adapter.inspect({
          source: encoder.encode(source),
          serverName: descriptor.server.name,
        }),
      });
      expect(patch.kind).toBe("changed");
      if (patch.kind !== "changed") throw new Error("Expected change.");
      expect(decoder.decode(patch.postImage)).toContain(preserved);
      expect(
        adapter.inspect({
          source: patch.postImage,
          serverName: descriptor.server.name,
        }).currentServer,
      ).toEqual({
        kind: "present",
        definition: adapter.descriptorToDefinition(descriptor),
      });
    },
  );

  it.each([
    "mcp_servers = 1979-05-27T07:32:00Z\n",
    "mcp_servers.invokta-support = 1979-05-27T07:32:00Z\n",
  ])("rejects a TOML datetime at an MCP object boundary", (source) => {
    expectInstallerCode(
      () =>
        configurationTargetAdapters.codex.inspect({
          source: encoder.encode(source),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
  });

  it.each([
    { source: "{}", preserved: "" },
    { source: "{theme: dark}", preserved: "theme: dark" },
    {
      source: "{mcp_servers: {other: {command: old, args: []}}}",
      preserved: "other: {command: old, args: []}",
    },
  ])(
    "installs into a YAML flow root or parent: $source",
    ({ source, preserved }) => {
      const adapter = configurationTargetAdapters.hermes;
      const descriptor = stdioDescriptor([]);
      const patch = adapter.constructPatch({
        action: "install",
        definition: adapter.descriptorToDefinition(descriptor),
        inspection: adapter.inspect({
          source: encoder.encode(source),
          serverName: descriptor.server.name,
        }),
      });
      expect(patch.kind).toBe("changed");
      if (patch.kind !== "changed") throw new Error("Expected change.");
      expect(decoder.decode(patch.postImage)).toContain(preserved);
      expect(
        adapter.inspect({
          source: patch.postImage,
          serverName: descriptor.server.name,
        }).currentServer,
      ).toEqual({
        kind: "present",
        definition: adapter.descriptorToDefinition(descriptor),
      });
    },
  );

  it("accepts quoted YAML << keys and still rejects an actual merge key", () => {
    const adapter = configurationTargetAdapters.hermes;
    for (const source of ['"<<": ordinary\n', "'<<': ordinary\n"]) {
      expect(
        adapter.inspect({
          source: encoder.encode(source),
          serverName: "invokta-support",
        }).currentServer,
      ).toEqual({ kind: "absent" });
    }
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: encoder.encode("object:\n  <<: { inherited: true }\n"),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
  });

  it.each([
    '!!merge "<<": ordinary\n',
    "!<tag:yaml.org,2002:merge> key: ordinary\n",
  ])("rejects an explicit YAML merge-tag key: %s", (source) => {
    expectInstallerCode(
      () =>
        configurationTargetAdapters.hermes.inspect({
          source: encoder.encode(source),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
  });

  it("accepts an explicitly tagged ordinary YAML string key named <<", () => {
    expect(
      configurationTargetAdapters.hermes.inspect({
        source: encoder.encode("!!str <<: ordinary\n"),
        serverName: "invokta-support",
      }).currentServer,
    ).toEqual({ kind: "absent" });
  });

  it.each([
    "1: numeric\n",
    "true: boolean\n",
    "? { complex: key }\n: value\n",
    "? [duplicate]\n: one\n? [duplicate]\n: two\n",
    'mcp_servers:\n  invokta-support:\n    command: support-engine-mcp\n    args: []\n    1: "lost"\n',
    'mcp_servers:\n  invokta-support:\n    url: https://support.example.com/mcp\n    headers:\n      true: "lost"\n',
  ])("rejects every non-string YAML mapping key: %s", (source) => {
    expectInstallerCode(
      () =>
        configurationTargetAdapters.hermes.inspect({
          source: encoder.encode(source),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
  });

  it.each(["theme: dark\n...\n", "---\ntheme: dark\n...\n"])(
    "installs before a YAML document-end marker: %s",
    (source) => {
      const adapter = configurationTargetAdapters.hermes;
      const descriptor = stdioDescriptor([]);
      const patch = adapter.constructPatch({
        action: "install",
        definition: adapter.descriptorToDefinition(descriptor),
        inspection: adapter.inspect({
          source: encoder.encode(source),
          serverName: descriptor.server.name,
        }),
      });
      expect(patch.kind).toBe("changed");
      if (patch.kind !== "changed") throw new Error("Expected change.");
      const postText = decoder.decode(patch.postImage);
      expect(postText.indexOf("mcp_servers:")).toBeLessThan(
        postText.indexOf("..."),
      );
      expect(postText.endsWith("...\n")).toBe(true);
      expect(
        adapter.inspect({
          source: patch.postImage,
          serverName: descriptor.server.name,
        }).currentServer,
      ).toEqual({
        kind: "present",
        definition: adapter.descriptorToDefinition(descriptor),
      });
    },
  );

  it.each(["---\n...\n", "%YAML 1.2\n---\n...\n", "# comment\n...\n"])(
    "installs into an empty YAML document before its end marker: %s",
    (source) => {
      const adapter = configurationTargetAdapters.hermes;
      const descriptor = stdioDescriptor([]);
      const patch = adapter.constructPatch({
        action: "install",
        definition: adapter.descriptorToDefinition(descriptor),
        inspection: adapter.inspect({
          source: encoder.encode(source),
          serverName: descriptor.server.name,
        }),
      });
      expect(patch.kind).toBe("changed");
      if (patch.kind !== "changed") throw new Error("Expected change.");
      const postText = decoder.decode(patch.postImage);
      expect(postText.indexOf("mcp_servers:")).toBeLessThan(
        postText.indexOf("..."),
      );
      expect(postText.endsWith("...\n")).toBe(true);
      expect(
        adapter.inspect({
          source: patch.postImage,
          serverName: descriptor.server.name,
        }).currentServer,
      ).toEqual({
        kind: "present",
        definition: adapter.descriptorToDefinition(descriptor),
      });
    },
  );

  it.each([
    "!!set {value: null}\n",
    "mcp_servers: !!set {value: null}\n",
    "mcp_servers:\n  invokta-support: !!set {value: null}\n",
  ])("rejects a nonstandard YAML collection tag: %s", (source) => {
    expectInstallerCode(
      () =>
        configurationTargetAdapters.hermes.inspect({
          source: encoder.encode(source),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
  });

  it.each([
    "theme: !!set {dark, light}\n",
    "theme: !!omap\n  - dark: '#000'\n  - light: '#fff'\n",
    "theme: !!pairs\n  - dark: '#000'\n  - light: '#fff'\n",
  ])(
    "preserves and traverses an unrelated tagged YAML collection while toggling: %s",
    (unrelated) => {
      const adapter = configurationTargetAdapters.hermes;
      const source = `${unrelated}mcp_servers:\n  invokta-support:\n    command: support-engine-mcp\n    args: []\n    enabled: false\n`;
      const inspection = adapter.inspect({
        source: encoder.encode(source),
        serverName: "invokta-support",
      });
      const patch = adapter.constructPatch({
        action: "enable",
        inspection,
      });
      expect(patch.kind).toBe("changed");
      if (patch.kind !== "changed") throw new Error("Expected change.");
      expect(decoder.decode(patch.postImage)).toBe(
        source.replace("enabled: false", "enabled: true"),
      );
    },
  );

  it("counts an unrelated YAML ordered-map pair as an implicit mapping depth", () => {
    const adapter = configurationTargetAdapters.hermes;
    const source = (wrappers: number) =>
      encoder.encode(
        `theme: ${"[".repeat(wrappers)}!!omap [{key: value}]${"]".repeat(wrappers)}\nmcp_servers:\n  invokta-support:\n    command: support-engine-mcp\n    args: []\n`,
      );
    expect(
      adapter.inspect({
        source: source(97),
        serverName: "invokta-support",
      }).currentServer.kind,
    ).toBe("present");
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: source(98),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
  });

  it("accepts explicit standard YAML map, sequence, and string tags", () => {
    const current = configurationTargetAdapters.hermes.inspect({
      source: encoder.encode(
        "!!map {mcp_servers: !!map {invokta-support: !!map {command: !!str support-engine-mcp, args: !!seq []}}}\n",
      ),
      serverName: "invokta-support",
    }).currentServer;
    expect(current.kind).toBe("present");
    if (current.kind !== "present") throw new Error("Expected server.");
    expect(current.definition).toMatchObject({
      command: "support-engine-mcp",
      args: [],
      enabled: true,
    });
  });

  it("installs into a YAML flow map whose trailing comment contains a comma", () => {
    const adapter = configurationTargetAdapters.hermes;
    const descriptor = stdioDescriptor([]);
    const source = encoder.encode("{theme: dark # footer, comma\n}\n");
    const patch = adapter.constructPatch({
      action: "install",
      definition: adapter.descriptorToDefinition(descriptor),
      inspection: adapter.inspect({
        source,
        serverName: descriptor.server.name,
      }),
    });
    expect(patch.kind).toBe("changed");
    if (patch.kind !== "changed") throw new Error("Expected change.");
    expect(decoder.decode(patch.postImage)).toContain("# footer, comma");
    expect(
      adapter.inspect({
        source: patch.postImage,
        serverName: descriptor.server.name,
      }).currentServer,
    ).toEqual({
      kind: "present",
      definition: adapter.descriptorToDefinition(descriptor),
    });
  });

  it.each(["codex", "hermes"] as const)(
    "preserves safe integer semantics and rejects collapsed unsafe integers for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const selected = (integer: string) =>
        targetId === "codex"
          ? `[mcp_servers.invokta-support]\ncommand = "support-engine-mcp"\nargs = []\nunknown_integer = ${integer}\n`
          : `mcp_servers:\n  invokta-support:\n    command: support-engine-mcp\n    args: []\n    unknown_integer: ${integer}\n`;
      const current = adapter.inspect({
        source: encoder.encode(selected("9007199254740991")),
        serverName: "invokta-support",
      }).currentServer;
      expect(current.kind).toBe("present");
      if (current.kind !== "present") throw new Error("Expected server.");
      expect(current.definition.unknown_integer).toBe(9_007_199_254_740_991);

      for (const integer of ["9007199254740992", "9007199254740993"]) {
        expectInstallerCode(
          () =>
            adapter.inspect({
              source: encoder.encode(selected(integer)),
              serverName: "invokta-support",
            }),
          "HARNESS_CONFIG_INVALID",
        );
      }
    },
  );

  it.each(["codex", "hermes", "openclaw"] as const)(
    "returns an immutable inspection snapshot for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const descriptor = stdioDescriptor([]);
      const inspection = adapter.inspect({
        source: install(targetId, descriptor),
        serverName: descriptor.server.name,
      });
      expect(Object.isFrozen(inspection)).toBe(true);
      expect(Object.isFrozen(inspection.currentServer)).toBe(true);
      expect(() => {
        Object.assign(inspection.currentServer, { kind: "absent" });
      }).toThrow(TypeError);
    },
  );

  it.each(["codex", "hermes", "openclaw"] as const)(
    "rejects a post-image whose selected definition differs from the requested definition for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const descriptor = stdioDescriptor([]);
      expectInstallerCode(
        () =>
          adapter.constructPatch({
            action: "install",
            definition: {
              ...adapter.descriptorToDefinition(descriptor),
              transport: "streamable-http",
            },
            inspection: adapter.inspect({
              source: undefined,
              serverName: descriptor.server.name,
            }),
          }),
        "HARNESS_CONFIG_INVALID",
      );
    },
  );

  it.each(["codex", "hermes", "openclaw"] as const)(
    "rejects a toggle post-image that differs from the inspected definition for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const descriptor = stdioDescriptor([]);
      const installed = install(targetId, descriptor);
      const disabled = adapter.constructPatch({
        action: "disable",
        inspection: adapter.inspect({
          source: installed,
          serverName: descriptor.server.name,
        }),
      });
      expect(disabled.kind).toBe("changed");
      if (disabled.kind !== "changed") throw new Error("Expected change.");
      const inspection = adapter.inspect({
        source: disabled.postImage,
        serverName: descriptor.server.name,
      });
      if (inspection.currentServer.kind !== "present") {
        throw new Error("Expected server.");
      }
      const inspectedDefinition = inspection.currentServer.definition;

      expectInstallerCode(
        () =>
          adapter.constructPatch({
            action: "enable",
            inspection: {
              ...inspection,
              currentServer: {
                kind: "present",
                definition: {
                  ...inspectedDefinition,
                  command: "different-command",
                },
              },
            },
          }),
        "HARNESS_CONFIG_INVALID",
      );
    },
  );

  it.each(["codex", "hermes", "openclaw"] as const)(
    "normalizes empty stdio environment defaults without emitting them for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const descriptor = stdioDescriptor([]);
      const definition = adapter.descriptorToDefinition(descriptor);
      expect(definition).toMatchObject(
        targetId === "codex" ? { env_vars: [] } : { env: {} },
      );
      const postImage = decoder.decode(install(targetId, descriptor));
      expect(postImage).not.toMatch(/env(?:_vars)?\s*[:=]/u);
    },
  );

  it.each(["codex", "hermes", "openclaw"] as const)(
    "normalizes credential-free HTTP defaults without emitting empty headers for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const descriptor = credentialFreeHttpDescriptor();
      const definition = adapter.descriptorToDefinition(descriptor);
      expect(definition).toMatchObject(
        targetId === "codex" ? { env_http_headers: {} } : { headers: {} },
      );
      const postImage = decoder.decode(install(targetId, descriptor));
      expect(postImage).not.toContain("headers");
      expect(postImage).not.toContain("bearer_token_env_var");
    },
  );

  it("never reads or serializes a process environment secret while mapping", () => {
    vi.stubEnv("SUPPORT_API_TOKEN", "actual-secret");
    try {
      for (const targetId of ["codex", "hermes", "openclaw"] as const) {
        const adapter = configurationTargetAdapters[targetId];
        const descriptor = stdioDescriptor(["SUPPORT_API_TOKEN"]);
        const definition = adapter.descriptorToDefinition(descriptor);
        const postImage = install(targetId, descriptor);
        expect(JSON.stringify(definition)).not.toContain("actual-secret");
        expect(decoder.decode(postImage)).not.toContain("actual-secret");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["codex", "hermes", "openclaw"] as const)(
    "maps and round-trips HTTP definitions for %s without resolving secrets",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const descriptor = httpDescriptor();
      expect(adapter.compatibility(descriptor)).toEqual({ supported: true });
      const definition = adapter.descriptorToDefinition(descriptor);
      expect(definition).toEqual(
        targetId === "codex"
          ? {
              transport: "streamable-http",
              url: "https://support.example.com/mcp",
              bearer_token_env_var: "SUPPORT_API_TOKEN",
              env_http_headers: {
                "x-support-tenant": "SUPPORT_TENANT",
              },
              enabled: true,
            }
          : targetId === "hermes"
            ? {
                transport: "streamable-http",
                url: "https://support.example.com/mcp",
                headers: {
                  authorization: `Bearer \${SUPPORT_API_TOKEN}`,
                  "x-support-tenant": `\${SUPPORT_TENANT}`,
                },
                enabled: true,
              }
            : {
                url: "https://support.example.com/mcp",
                transport: "streamable-http",
                headers: {
                  authorization: `Bearer \${SUPPORT_API_TOKEN}`,
                  "x-support-tenant": `\${SUPPORT_TENANT}`,
                },
                enabled: true,
              },
      );

      const postImage = install(targetId, descriptor);
      expect(decoder.decode(postImage)).not.toContain("actual-secret");
      if (targetId !== "codex") {
        expect(decoder.decode(postImage)).toContain("Authorization");
      }
      expect(
        adapter.inspect({
          source: postImage,
          serverName: descriptor.server.name,
        }).currentServer,
      ).toEqual({ kind: "present", definition });
    },
  );

  it("pins OpenClaw environment compatibility to the reviewed snapshot", () => {
    expect(openClawEnvironmentPolicyCommit).toBe(
      "f308af8a344a30432e1b13fa348533e54cd190c8",
    );
    expect(openClawDeniedEnvironmentNameSnapshot).toHaveLength(194);
    expect(new Set(openClawDeniedEnvironmentNameSnapshot).size).toBe(194);
    expect(Object.isFrozen(openClawDeniedEnvironmentNameSnapshot)).toBe(true);
    const adapter = configurationTargetAdapters.openclaw;
    for (const name of [
      "NODE_OPTIONS",
      "ANSIBLE_CONFIG",
      "TF_CLI_CONFIG_FILE",
      "LD_PRELOAD",
      "dyld_insert_libraries",
      " BASH_FUNC_probe ",
    ]) {
      expect(adapter.compatibility(stdioDescriptor([name]))).toEqual({
        supported: false,
        reason: `openclaw-env-denied:${name}`,
      });
      expectInstallerCode(
        () => adapter.descriptorToDefinition(stdioDescriptor([name])),
        "TARGET_UNSUPPORTED",
      );
    }
    for (const name of [
      "GITHUB_TOKEN",
      "SUPPORT_API_TOKEN",
      "AWS_CONFIG_FILE",
    ]) {
      expect(adapter.compatibility(stdioDescriptor([name]))).toEqual({
        supported: true,
      });
    }
  });

  it.each([
    {
      targetId: "codex" as const,
      source:
        '# keep top\r\ntheme = "dark"\r\n\r\n[mcp_servers.other]\r\ncommand = "old"',
      top: '# keep top\r\ntheme = "dark"',
      preserved: '[mcp_servers.other]\r\ncommand = "old"',
      inserted: "[mcp_servers.invokta-support]",
    },
    {
      targetId: "hermes" as const,
      source:
        "# keep top\r\nmcp_servers:\r\n  other:\r\n    command: old\r\ntheme: dark",
      top: "# keep top\r\nmcp_servers:",
      preserved: "  other:\r\n    command: old",
      inserted: "  invokta-support:",
    },
    {
      targetId: "openclaw" as const,
      source: "{ theme:'dark', mcp:{servers:{other:{command:'old',args:[]}}}}",
      top: "{ theme:'dark'",
      preserved: "other:{command:'old',args:[]}",
      inserted: '"invokta-support":',
    },
  ])(
    "adds only the selected server and preserves existing bytes for $targetId",
    ({ targetId, source, top, preserved, inserted }) => {
      const adapter = configurationTargetAdapters[targetId];
      const descriptor = stdioDescriptor([]);
      const patch = adapter.constructPatch({
        action: "install",
        definition: adapter.descriptorToDefinition(descriptor),
        inspection: adapter.inspect({
          source: encoder.encode(source),
          serverName: descriptor.server.name,
        }),
      });
      expect(patch.kind).toBe("changed");
      if (patch.kind !== "changed") throw new Error("Expected change.");
      const postImage = decoder.decode(patch.postImage);
      expect(postImage).toContain(top);
      expect(postImage).toContain(preserved);
      expect(postImage).toContain(inserted);
      expect(postImage.endsWith("\n")).toBe(false);
      if (source.includes("\r\n")) {
        expect(postImage.replaceAll("\r\n", "")).not.toContain("\n");
      }
    },
  );

  it.each([
    {
      targetId: "codex" as const,
      source:
        '# keep top\r\ntheme = "dark"\r\n\r\n[mcp_servers.invokta-support]\r\ncommand = "support-engine-mcp"\r\nargs = []\r\n# keep selected\r\nenabled = true',
      disabled: "enabled = false",
    },
    {
      targetId: "hermes" as const,
      source:
        "# keep top\r\ntheme: dark\r\nmcp_servers:\r\n  invokta-support:\r\n    command: support-engine-mcp\r\n    args: []\r\n    # keep selected\r\n    enabled: true",
      disabled: "enabled: false",
    },
    {
      targetId: "openclaw" as const,
      source:
        "{\r\n  // keep top\r\n  theme: 'dark',\r\n  mcp: { servers: {\r\n    'invokta-support': { command: 'support-engine-mcp', args: [], enabled: true }\r\n  } }\r\n}",
      disabled: "enabled: false",
    },
  ])(
    "changes only native enablement and preserves byte conventions for $targetId",
    ({ targetId, source, disabled }) => {
      const adapter = configurationTargetAdapters[targetId];
      const sourceBytes = encoder.encode(`\ufeff${source}`);
      const inspected = adapter.inspect({
        source: sourceBytes,
        serverName: "invokta-support",
      });
      const patch = adapter.constructPatch({
        action: "disable",
        inspection: inspected,
      });
      expect(patch.kind).toBe("changed");
      if (patch.kind !== "changed") throw new Error("Expected change.");
      const text = decoder.decode(patch.postImage);
      expect(
        text.startsWith("\ufeff# keep top") || text.startsWith("\ufeff{"),
      ).toBe(true);
      expect(text).toContain(disabled);
      expect(text).toContain("keep top");
      expect(text.endsWith("\n")).toBe(false);
      expect(text.replaceAll("\r\n", "")).not.toContain("\n");

      const repeat = adapter.constructPatch({
        action: "disable",
        inspection: adapter.inspect({
          source: patch.postImage,
          serverName: "invokta-support",
        }),
      });
      expect(repeat).toEqual({ kind: "unchanged" });
    },
  );

  it.each(["codex", "hermes", "openclaw"] as const)(
    "treats omitted enabled as true, adds an explicit false, then flips only that scalar for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const installed = install(targetId, stdioDescriptor([]));
      const text = decoder.decode(installed);
      const withoutEnabled = encoder.encode(
        text.replace(/^\s*enabled\s*[:=]\s*true,?\s*$/mu, ""),
      );
      const inspection = adapter.inspect({
        source: withoutEnabled,
        serverName: "invokta-support",
      });
      expect(
        inspection.currentServer.kind === "present" &&
          inspection.currentServer.definition.enabled,
      ).toBe(true);
      expect(adapter.constructPatch({ action: "enable", inspection })).toEqual({
        kind: "unchanged",
      });
      const disabled = adapter.constructPatch({
        action: "disable",
        inspection,
      });
      expect(disabled.kind).toBe("changed");
      if (disabled.kind !== "changed") throw new Error("Expected change.");
      const reenabled = adapter.constructPatch({
        action: "enable",
        inspection: adapter.inspect({
          source: disabled.postImage,
          serverName: "invokta-support",
        }),
      });
      expect(reenabled.kind).toBe("changed");
      if (reenabled.kind !== "changed") throw new Error("Expected change.");
      expect(decoder.decode(reenabled.postImage)).toContain(
        targetId === "codex"
          ? "enabled = true"
          : targetId === "openclaw"
            ? '"enabled": true'
            : "enabled: true",
      );
    },
  );

  it("rejects invalid encodings, BOM placement, wrong parents, duplicates, and OpenClaw includes", () => {
    const cases = [
      {
        adapter: configurationTargetAdapters.codex,
        source: encoder.encode('mcp_servers = "wrong"\n'),
        code: "HARNESS_CONFIG_INVALID" as const,
      },
      {
        adapter: configurationTargetAdapters.codex,
        source: encoder.encode("theme = 1\ntheme = 2\n"),
        code: "HARNESS_CONFIG_INVALID" as const,
      },
      {
        adapter: configurationTargetAdapters.codex,
        source: encoder.encode(
          '[mcp_servers.invokta-support]\nurl = "https://support.example.com/mcp"\nenv_http_headers.Authorization = "ONE"\nenv_http_headers.authorization = "TWO"\n',
        ),
        code: "HARNESS_CONFIG_INVALID" as const,
      },
      {
        adapter: configurationTargetAdapters.codex,
        source: encoder.encode(
          '[mcp_servers.invokta-support]\ncommand = "support-engine-mcp"\nargs = []\nunknown_date = 1979-05-27T07:32:00Z\n',
        ),
        code: "HARNESS_CONFIG_INVALID" as const,
      },
      {
        adapter: configurationTargetAdapters.hermes,
        source: encoder.encode("mcp_servers: []\n"),
        code: "HARNESS_CONFIG_INVALID" as const,
      },
      {
        adapter: configurationTargetAdapters.hermes,
        source: encoder.encode("value: &shared 1\nother: *shared\n"),
        code: "HARNESS_CONFIG_INVALID" as const,
      },
      {
        adapter: configurationTargetAdapters.hermes,
        source: encoder.encode("base: {}\nobject:\n  <<: {}\n"),
        code: "HARNESS_CONFIG_INVALID" as const,
      },
      {
        adapter: configurationTargetAdapters.hermes,
        source: encoder.encode("mcp_servers: {}\nmcp_servers: {}\n"),
        code: "HARNESS_CONFIG_INVALID" as const,
      },
      {
        adapter: configurationTargetAdapters.hermes,
        source: encoder.encode(
          "mcp_servers:\n  invokta-support:\n    url: https://support.example.com/mcp\n    headers: { Authorization: ONE, authorization: TWO }\n",
        ),
        code: "HARNESS_CONFIG_INVALID" as const,
      },
      {
        adapter: configurationTargetAdapters.openclaw,
        source: encoder.encode("{ mcp: [] }"),
        code: "HARNESS_CONFIG_INVALID" as const,
      },
      {
        adapter: configurationTargetAdapters.openclaw,
        source: encoder.encode("{ mcp: {}, mcp: {} }"),
        code: "HARNESS_CONFIG_INVALID" as const,
      },
      {
        adapter: configurationTargetAdapters.openclaw,
        source: encoder.encode(
          "{ mcp: { servers: { 'invokta-support': { url: 'https://support.example.com/mcp', headers: { Authorization: 'ONE', authorization: 'TWO' } } } } }",
        ),
        code: "HARNESS_CONFIG_INVALID" as const,
      },
      {
        adapter: configurationTargetAdapters.openclaw,
        source: encoder.encode("{ nested: { $include: './other.json5' } }"),
        code: "HARNESS_CONFIG_AMBIGUOUS" as const,
      },
      {
        adapter: configurationTargetAdapters.openclaw,
        source: encoder.encode("{ '\\u0024include': './other.json5' }"),
        code: "HARNESS_CONFIG_AMBIGUOUS" as const,
      },
    ];
    for (const { adapter, source, code } of cases) {
      expectInstallerCode(
        () => adapter.inspect({ source, serverName: "invokta-support" }),
        code,
      );
    }
    expectInstallerCode(
      () =>
        configurationTargetAdapters.openclaw.inspect({
          source: new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
    expectInstallerCode(
      () =>
        configurationTargetAdapters.codex.inspect({
          source: encoder.encode('theme = "x\ufeffy"\n'),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
    expectInstallerCode(
      () =>
        configurationTargetAdapters.codex.inspect({
          source: new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]),
          serverName: "invokta-support",
        }),
      "HARNESS_CONFIG_INVALID",
    );
  });

  it("accepts depth 100, rejects depth 101 before patch construction, and records one pass", () => {
    const adapter = configurationTargetAdapters.openclaw;
    const nested = (depth: number) =>
      encoder.encode(
        depth === 1
          ? "{}"
          : `{"nested":${"[".repeat(depth - 1)}0${"]".repeat(depth - 1)}}`,
      );
    const counters = createTargetAdapterCounters();
    expect(
      adapter.inspect({
        source: nested(100),
        serverName: "invokta-support",
        counters,
      }).currentServer,
    ).toEqual({ kind: "absent" });
    expect(counters).toEqual({
      sourceDecodePasses: 1,
      sourceParsePasses: 1,
      inspectionPasses: 1,
      patchConstructionPasses: 0,
      postImageEncodePasses: 0,
      postImageDecodePasses: 0,
      postImageParsePasses: 0,
    });

    const rejected = createTargetAdapterCounters();
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: nested(101),
          serverName: "invokta-support",
          counters: rejected,
        }),
      "HARNESS_CONFIG_INVALID",
    );
    expect(rejected.patchConstructionPasses).toBe(0);
  });

  it.each([
    {
      targetId: "codex" as const,
      source: (depth: number) =>
        encoder.encode(
          `value = ${"[".repeat(depth - 1)}0${"]".repeat(depth - 1)}\n`,
        ),
    },
    {
      targetId: "hermes" as const,
      source: (depth: number) =>
        encoder.encode(
          `value: ${"[".repeat(depth - 1)}0${"]".repeat(depth - 1)}\n`,
        ),
    },
  ])("enforces depth 100/101 for $targetId", ({ targetId, source }) => {
    const adapter = configurationTargetAdapters[targetId];
    expect(
      adapter.inspect({
        source: source(100),
        serverName: "invokta-support",
      }).currentServer,
    ).toEqual({ kind: "absent" });
    const counters = createTargetAdapterCounters();
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: source(101),
          serverName: "invokta-support",
          counters,
        }),
      "HARNESS_CONFIG_INVALID",
    );
    expect(counters.patchConstructionPasses).toBe(0);
  });

  it("enforces the inclusive 4 MiB source limit before decoding", () => {
    const adapter = configurationTargetAdapters.codex;
    const base = encoder.encode("theme = true\n");
    const exact = new Uint8Array(4_194_304);
    exact.fill(0x20);
    exact.set(base);
    const counters = createTargetAdapterCounters();
    expect(
      adapter.inspect({
        source: exact,
        serverName: "invokta-support",
        counters,
      }).currentServer,
    ).toEqual({ kind: "absent" });
    expect(counters.sourceDecodePasses).toBe(1);
    expect(counters.sourceParsePasses).toBe(1);

    const over = new Uint8Array(4_194_305);
    const rejected = createTargetAdapterCounters();
    expectInstallerCode(
      () =>
        adapter.inspect({
          source: over,
          serverName: "invokta-support",
          counters: rejected,
        }),
      "HARNESS_CONFIG_INVALID",
    );
    expect(rejected.sourceDecodePasses).toBe(0);
    expect(rejected.sourceParsePasses).toBe(0);
  });

  it("rejects a 4 MiB plus one post-image before post-image decoding", () => {
    const adapter = configurationTargetAdapters.codex;
    const prefix = encoder.encode(
      '[mcp_servers.invokta-support]\ncommand = "support-engine-mcp"\nargs = []\nenabled = true\n',
    );
    const source = new Uint8Array(4_194_304);
    source.fill(0x20);
    source.set(prefix);
    const counters = createTargetAdapterCounters();
    const inspection = adapter.inspect({
      source,
      serverName: "invokta-support",
      counters,
    });
    expectInstallerCode(
      () => adapter.constructPatch({ action: "disable", inspection, counters }),
      "HARNESS_CONFIG_INVALID",
    );
    expect(counters).toMatchObject({
      sourceDecodePasses: 1,
      sourceParsePasses: 1,
      inspectionPasses: 1,
      patchConstructionPasses: 1,
      postImageEncodePasses: 1,
      postImageDecodePasses: 0,
      postImageParsePasses: 0,
    });
  });

  it.each(["codex", "hermes", "openclaw"] as const)(
    "counts one source and post-image pass for a changed %s patch",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const counters = createTargetAdapterCounters();
      const descriptor = stdioDescriptor([]);
      const inspection = adapter.inspect({
        source: encoder.encode(targetId === "codex" ? "" : "{}"),
        serverName: descriptor.server.name,
        counters,
      });
      const patch = adapter.constructPatch({
        action: "install",
        definition: adapter.descriptorToDefinition(descriptor),
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
    },
  );

  it.each(["codex", "hermes", "openclaw"] as const)(
    "maps suspended descriptors through the same normalized contract for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const descriptor = stdioDescriptor([]);
      expect(
        adapter.suspendedDescriptorToDefinition(descriptor.server),
      ).toEqual(adapter.descriptorToDefinition(descriptor));
    },
  );
});
