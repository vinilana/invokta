import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallerError } from "../src/installer-error.js";
import { fingerprintNormalizedDefinition } from "../src/jcs-fingerprint.js";
import { createNodeFileSystem } from "../src/node-file-system.js";
import type { CapabilityInstallDescriptor } from "../src/registry.js";
import {
  type TargetAdapter,
  type TargetConfigInspection,
  targetConfigByteLimit,
} from "../src/target-adapter.js";
import {
  configurationTargetAdapters,
  createTargetAdapterCounters,
  registryCompatibilityAdapters,
} from "../src/target-adapters.js";
import { createNodeTargetConfigEvidenceProbes } from "../src/target-config-evidence.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const temporaryDirectories: string[] = [];
const singleFullPassCounters = Object.freeze({
  sourceDecodePasses: 1,
  sourceParsePasses: 1,
  inspectionPasses: 1,
  patchConstructionPasses: 1,
  postImageEncodePasses: 1,
  postImageDecodePasses: 1,
  postImageParsePasses: 1,
});

type SliceNineTargetId = "grok-build" | "opencode-v2";

afterEach(() => {
  vi.unstubAllEnvs();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, {
      force: true,
      recursive: true,
    });
  }
});

function adapter(targetId: SliceNineTargetId): TargetAdapter {
  return (configurationTargetAdapters as Record<string, TargetAdapter>)[
    targetId
  ] as TargetAdapter;
}

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

function credentialFreeHttpDescriptor(
  headersFromEnv: Readonly<Record<string, string>> = {},
): CapabilityInstallDescriptor {
  return {
    ...httpDescriptor({}),
    server: {
      name: "invokta-support",
      transport: {
        type: "streamable-http",
        url: "https://support.example.com/mcp",
        authentication: { type: "none" },
        headersFromEnv,
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

function install(
  targetId: SliceNineTargetId,
  descriptor: CapabilityInstallDescriptor,
  source?: Uint8Array,
): Uint8Array {
  const selected = adapter(targetId);
  const patch = selected.constructPatch({
    action: "install",
    definition: selected.descriptorToDefinition(descriptor),
    inspection: selected.inspect({
      source,
      serverName: descriptor.server.name,
    }),
  });
  expect(patch.kind).toBe("changed");
  if (patch.kind !== "changed") throw new Error("Expected changed patch.");
  return patch.postImage;
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

function parseGrokNativeDocument(source: string) {
  const ast = parseTOML(source, { tomlVersion: "1.0.0" });
  const topLevel = ast.body[0];
  if (topLevel === undefined) throw new Error("Expected a TOML document.");
  expect(topLevel.body).toHaveLength(1);
  const table = topLevel.body[0];
  if (table?.type !== "TOMLTable") {
    throw new Error("Expected one native Grok MCP table.");
  }
  expect(table.resolvedKey).toEqual(["mcp_servers", "invokta-support"]);
  return {
    keys: table.body.map((pair) =>
      pair.key.keys
        .map((part) => (part.type === "TOMLBare" ? part.name : part.value))
        .join("."),
    ),
    semantic: getStaticTOMLValue(ast),
  };
}

describe("OpenCode v2 JSONC and Grok Build TOML target adapters", () => {
  it("publishes immutable target contracts and replaces both compatibility placeholders", () => {
    expect(adapter("opencode-v2").metadata).toEqual({
      targetId: "opencode-v2",
      targetContractVersion: 1,
      format: "jsonc",
      parentPath: ["mcp", "servers"],
      toggleStrategy: "native-disabled",
    });
    expect(adapter("grok-build").metadata).toEqual({
      targetId: "grok-build",
      targetContractVersion: 1,
      format: "toml",
      parentPath: ["mcp_servers"],
      toggleStrategy: "native-enabled",
    });
    for (const targetId of ["opencode-v2", "grok-build"] as const) {
      expect(Object.isFrozen(adapter(targetId).metadata)).toBe(true);
      for (const descriptor of [
        stdioDescriptor(),
        httpDescriptor(),
        credentialFreeHttpDescriptor(),
      ]) {
        expect(registryCompatibilityAdapters[targetId](descriptor)).toEqual({
          supported: true,
        });
        expect(
          adapter(targetId).suspendedDescriptorToDefinition(descriptor.server),
        ).toEqual(adapter(targetId).descriptorToDefinition(descriptor));
      }
    }
  });

  it("maps exact stdio definitions and writes no synthetic transport field", () => {
    expect(
      adapter("opencode-v2").descriptorToDefinition(stdioDescriptor()),
    ).toEqual({
      transport: "stdio",
      type: "local",
      command: ["support-engine-mcp", "serve", "--stdio"],
      environment: { SUPPORT_API_TOKEN: "{env:SUPPORT_API_TOKEN}" },
      disabled: false,
    });
    expect(
      adapter("grok-build").descriptorToDefinition(stdioDescriptor()),
    ).toEqual({
      transport: "stdio",
      command: "support-engine-mcp",
      args: ["serve", "--stdio"],
      env: { SUPPORT_API_TOKEN: `\${SUPPORT_API_TOKEN}` },
      enabled: true,
    });

    for (const targetId of ["opencode-v2", "grok-build"] as const) {
      const selected = adapter(targetId);
      const definition = selected.descriptorToDefinition(stdioDescriptor());
      const postImage = install(targetId, stdioDescriptor());
      expect(decoder.decode(postImage)).not.toContain('"transport"');
      expect(
        selected.inspect({
          source: postImage,
          serverName: "invokta-support",
        }).currentServer,
      ).toEqual({ kind: "present", definition });
    }
  });

  it("maps exact remote definitions, forces OpenCode oauth false, and omits empty headers", () => {
    expect(
      adapter("opencode-v2").descriptorToDefinition(httpDescriptor()),
    ).toEqual({
      transport: "streamable-http",
      type: "remote",
      url: "https://support.example.com/mcp",
      oauth: false,
      headers: {
        authorization: "Bearer {env:SUPPORT_API_TOKEN}",
        "x-support-tenant": "{env:SUPPORT_TENANT}",
      },
      disabled: false,
    });
    expect(
      adapter("grok-build").descriptorToDefinition(httpDescriptor()),
    ).toEqual({
      transport: "streamable-http",
      url: "https://support.example.com/mcp",
      headers: {
        authorization: `Bearer \${SUPPORT_API_TOKEN}`,
        "x-support-tenant": `\${SUPPORT_TENANT}`,
      },
      enabled: true,
    });

    for (const targetId of ["opencode-v2", "grok-build"] as const) {
      const remote = decoder.decode(install(targetId, httpDescriptor()));
      const credentialFree = decoder.decode(
        install(targetId, credentialFreeHttpDescriptor()),
      );
      expect(remote).toContain("Authorization");
      expect(remote).not.toContain("actual-secret");
      expect(credentialFree).not.toContain("headers");
      if (targetId === "opencode-v2") {
        expect(remote).toMatch(/"oauth":\s*false/u);
        expect(credentialFree).toMatch(/"oauth":\s*false/u);
      }
    }
  });

  it("emits independent native OpenCode JSON goldens for stdio and HTTP", () => {
    const stdio = JSON.parse(
      decoder.decode(install("opencode-v2", stdioDescriptor())),
    );
    expect(Object.keys(stdio)).toEqual(["mcp"]);
    expect(Object.keys(stdio.mcp)).toEqual(["servers"]);
    expect(stdio).toEqual({
      mcp: {
        servers: {
          "invokta-support": {
            type: "local",
            command: ["support-engine-mcp", "serve", "--stdio"],
            environment: {
              SUPPORT_API_TOKEN: "{env:SUPPORT_API_TOKEN}",
            },
            disabled: false,
          },
        },
      },
    });

    const http = JSON.parse(
      decoder.decode(install("opencode-v2", httpDescriptor())),
    );
    expect(Object.keys(http)).toEqual(["mcp"]);
    expect(Object.keys(http.mcp)).toEqual(["servers"]);
    expect(http).toEqual({
      mcp: {
        servers: {
          "invokta-support": {
            type: "remote",
            url: "https://support.example.com/mcp",
            oauth: false,
            headers: {
              Authorization: "Bearer {env:SUPPORT_API_TOKEN}",
              "x-support-tenant": "{env:SUPPORT_TENANT}",
            },
            disabled: false,
          },
        },
      },
    });
  });

  it("emits independent native Grok TOML goldens for stdio and HTTP", () => {
    const stdio = parseGrokNativeDocument(
      decoder.decode(install("grok-build", stdioDescriptor())),
    );
    expect(stdio.keys).toEqual(["command", "args", "env", "enabled"]);
    expect(stdio.semantic).toEqual({
      mcp_servers: {
        "invokta-support": {
          command: "support-engine-mcp",
          args: ["serve", "--stdio"],
          env: { SUPPORT_API_TOKEN: `\${SUPPORT_API_TOKEN}` },
          enabled: true,
        },
      },
    });

    const http = parseGrokNativeDocument(
      decoder.decode(install("grok-build", httpDescriptor())),
    );
    expect(http.keys).toEqual(["url", "headers", "enabled"]);
    expect(http.semantic).toEqual({
      mcp_servers: {
        "invokta-support": {
          url: "https://support.example.com/mcp",
          headers: {
            Authorization: `Bearer \${SUPPORT_API_TOKEN}`,
            "x-support-tenant": `\${SUPPORT_TENANT}`,
          },
          enabled: true,
        },
      },
    });
  });

  it("installs a bare Authorization placeholder when authentication is none", () => {
    const descriptor = credentialFreeHttpDescriptor({
      Authorization: "SUPPORT_AUTHORIZATION",
    });

    for (const targetId of ["opencode-v2", "grok-build"] as const) {
      const selected = adapter(targetId);
      expect(registryCompatibilityAdapters[targetId](descriptor)).toEqual({
        supported: true,
      });

      const definition = selected.descriptorToDefinition(descriptor);
      expect(definition.headers).toEqual({
        authorization:
          targetId === "opencode-v2"
            ? "{env:SUPPORT_AUTHORIZATION}"
            : `\${SUPPORT_AUTHORIZATION}`,
      });

      const postImage = install(targetId, descriptor);
      expect(
        selected.inspect({
          source: postImage,
          serverName: descriptor.server.name,
        }).currentServer,
      ).toEqual({ kind: "present", definition });
    }
  });

  it("never reads a process secret while mapping either target", () => {
    vi.stubEnv("SUPPORT_API_TOKEN", "actual-secret");
    for (const targetId of ["opencode-v2", "grok-build"] as const) {
      const definition = adapter(targetId).descriptorToDefinition(
        stdioDescriptor(),
      );
      expect(JSON.stringify(definition)).not.toContain("actual-secret");
      expect(
        decoder.decode(install(targetId, stdioDescriptor())),
      ).not.toContain("actual-secret");
    }
  });

  it.each(["opencode-v2", "grok-build"] as const)(
    "transitions install, disable, and enable idempotently for %s",
    (targetId) => {
      const selected = adapter(targetId);
      const definition = selected.descriptorToDefinition(stdioDescriptor());
      const installed = install(targetId, stdioDescriptor());
      const installedInspection = selected.inspect({
        source: installed,
        serverName: "invokta-support",
      });
      expect(
        selected.constructPatch({
          action: "enable",
          inspection: installedInspection,
        }),
      ).toEqual({ kind: "unchanged" });
      const disabled = selected.constructPatch({
        action: "disable",
        inspection: installedInspection,
      });
      expect(disabled.kind).toBe("changed");
      if (disabled.kind !== "changed") return;
      const disabledInspection = selected.inspect({
        source: disabled.postImage,
        serverName: "invokta-support",
      });
      expect(disabledInspection.currentServer).toMatchObject({
        kind: "present",
        definition:
          targetId === "opencode-v2" ? { disabled: true } : { enabled: false },
      });
      expect(
        selected.constructPatch({
          action: "disable",
          inspection: disabledInspection,
        }),
      ).toEqual({ kind: "unchanged" });
      const reenabled = selected.constructPatch({
        action: "enable",
        inspection: disabledInspection,
      });
      expect(reenabled.kind).toBe("changed");
      if (reenabled.kind !== "changed") return;
      expect(
        selected.inspect({
          source: reenabled.postImage,
          serverName: "invokta-support",
        }).currentServer,
      ).toEqual({ kind: "present", definition });
    },
  );

  it("accepts strict JSON and JSONC, preserving comments, trailing commas, CRLF, and trailing-newline state", () => {
    const selected = adapter("opencode-v2");
    const source = [
      "{",
      "  // root comment",
      '  "theme": {"mode":"dark"},',
      '  "mcp": {',
      '    "note": "preserve",',
      '    "servers": {',
      "      // server comment",
      "    },",
      "  },",
      "}",
    ].join("\r\n");
    const postImage = install(
      "opencode-v2",
      stdioDescriptor(),
      encoder.encode(source),
    );
    const postText = decoder.decode(postImage);
    expect(postText.endsWith("\n")).toBe(false);
    for (const preserved of [
      "// root comment",
      '"theme": {"mode":"dark"}',
      '"note": "preserve"',
      "// server comment",
    ]) {
      expect(postText).toContain(preserved);
    }
    expect(postText.replaceAll("\r\n", "")).not.toContain("\n");
    expect(
      selected.inspect({
        source: postImage,
        serverName: "invokta-support",
      }).currentServer.kind,
    ).toBe("present");

    expect(
      selected.inspect({
        source: encoder.encode(
          '{"mcp":{"servers":{"invokta-support":{"type":"local","command":["x"]}}}}',
        ),
        serverName: "invokta-support",
      }).currentServer,
    ).toMatchObject({
      kind: "present",
      definition: { disabled: false },
    });
  });

  it("inserts OpenCode disabled beside a trailing comma without producing a double comma", () => {
    const selected = adapter("opencode-v2");
    const source = encoder.encode(
      '{\n  "mcp": {\n    "servers": {\n      "invokta-support": {\n        "type": "local",\n        "command": ["support-engine-mcp"],\n        // preserve footer\n      },\n    },\n  },\n}',
    );
    const inspection = selected.inspect({
      source,
      serverName: "invokta-support",
    });
    const disabled = selected.constructPatch({
      action: "disable",
      inspection,
    });
    expect(disabled.kind).toBe("changed");
    if (disabled.kind !== "changed") return;
    const postText = decoder.decode(disabled.postImage);
    expect(postText).not.toContain(",,");
    expect(postText).toContain("// preserve footer");
    expect(
      selected.inspect({
        source: disabled.postImage,
        serverName: "invokta-support",
      }).currentServer,
    ).toMatchObject({ kind: "present", definition: { disabled: true } });
  });

  it.each([
    "{}",
    '{"mcp":{"future":true}}',
    '{"mcp":{"servers":{"other":{"type":"local","command":["old"]}}}}',
  ])("installs OpenCode through every missing nested parent: %s", (source) => {
    const postImage = install(
      "opencode-v2",
      stdioDescriptor([]),
      encoder.encode(source),
    );
    expect(
      adapter("opencode-v2").inspect({
        source: postImage,
        serverName: "invokta-support",
      }).currentServer.kind,
    ).toBe("present");
  });

  it("does not normalize existing OpenCode OAuth semantics to false", () => {
    const selected = adapter("opencode-v2");
    const inspect = (oauth: string) =>
      selected.inspect({
        source: encoder.encode(
          `{"mcp":{"servers":{"invokta-support":{"type":"remote","url":"https://support.example.com/mcp"${oauth}}}}}`,
        ),
        serverName: "invokta-support",
      });
    const omitted = inspect("");
    const enabled = inspect(',"oauth":true');
    const configured = inspect(
      ',"oauth":{"client_id":"client","scope":"openid profile"}',
    );
    expect(omitted.currentServer).toMatchObject({
      kind: "present",
      definition: { type: "remote" },
    });
    expect(enabled.currentServer).toMatchObject({
      kind: "present",
      definition: { type: "remote", oauth: true },
    });
    expect(configured.currentServer).toMatchObject({
      kind: "present",
      definition: { oauth: { client_id: "client", scope: "openid profile" } },
    });
    if (
      omitted.currentServer.kind !== "present" ||
      enabled.currentServer.kind !== "present"
    ) {
      return;
    }
    expect(Object.hasOwn(omitted.currentServer.definition, "oauth")).toBe(
      false,
    );
    expect(
      fingerprintNormalizedDefinition(
        omitted.currentServer.definition,
        "native-disabled",
      ),
    ).not.toBe(
      fingerprintNormalizedDefinition(
        enabled.currentServer.definition,
        "native-disabled",
      ),
    );
    const toggled = selected.constructPatch({
      action: "disable",
      inspection: enabled,
    });
    expect(toggled.kind).toBe("changed");
    if (toggled.kind !== "changed") return;
    expect(decoder.decode(toggled.postImage)).toContain('"oauth":true');
  });

  it("rejects JSON5-only syntax, decoded duplicates, wrong OpenCode shapes, and raw transport", () => {
    const selected = adapter("opencode-v2");
    for (const source of [
      "{mcp:{servers:{}}}",
      "{'mcp':{'servers':{}}}",
      '{"value":0x10}',
      '{"value":Infinity}',
      '{"mcp":{},"m\\u0063p":{}}',
      '{"mcp":false}',
      '{"mcp":{"servers":[]}}',
      '{"mcp":{"servers":{"invokta-support":[]}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"local","command":[]}}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"local","command":["x",false]}}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"stdio","command":["x"]}}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"local","command":["x"],"environment":[]}}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"remote","url":"x","headers":[]}}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"remote","url":"x","oauth":"false"}}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"remote","url":"x","oauth":1}}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"remote","url":"x","oauth":null}}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"remote","url":"x","oauth":[]}}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"local","command":["x"],"url":"x"}}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"remote","url":"x","headers":{"X":"1","x":"2"}}}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"local","command":["x"],"disabled":"false"}}}}',
      '{"mcp":{"servers":{"invokta-support":{"type":"local","command":["x"],"transport":"stdio"}}}}',
    ]) {
      expectInstallerCode(
        () =>
          selected.inspect({
            source: encoder.encode(source),
            serverName: "invokta-support",
          }),
        "HARNESS_CONFIG_INVALID",
      );
    }
  });

  it("patches Grok explicit, dotted, and inline TOML locally with its native fields", () => {
    const selected = adapter("grok-build");
    for (const source of [
      `[mcp_servers.invokta-support]\ncommand = "support-engine-mcp"\nargs = []\nenv = { SUPPORT_API_TOKEN = "\${SUPPORT_API_TOKEN}" }\nenabled = false\n`,
      'mcp_servers.invokta-support.command = "support-engine-mcp"\nmcp_servers.invokta-support.args = []\nmcp_servers.invokta-support.enabled = false\n',
      'mcp_servers = { invokta-support = { command = "support-engine-mcp", args = [], enabled = false }, other = { command = "old", args = [] } }\n',
    ]) {
      const enabled = selected.constructPatch({
        action: "enable",
        inspection: selected.inspect({
          source: encoder.encode(source),
          serverName: "invokta-support",
        }),
      });
      expect(enabled.kind).toBe("changed");
      if (enabled.kind !== "changed") continue;
      expect(
        selected.inspect({
          source: enabled.postImage,
          serverName: "invokta-support",
        }).currentServer,
      ).toMatchObject({ kind: "present", definition: { enabled: true } });
    }
  });

  it("preserves Grok comments, multiline strings, CRLF, and no trailing newline", () => {
    const selected = adapter("grok-build");
    const source = [
      "# preserved top",
      'ordinary = "enabled = false"',
      "[mcp_servers.invokta-support]",
      'command = "support-engine-mcp"',
      "args = []",
      'note = """',
      "enabled = false",
      'headers.Authorization = "inside-string"',
      '"""',
      "enabled = false",
      "[unrelated]",
      'order = "preserved"',
    ].join("\r\n");
    const patch = selected.constructPatch({
      action: "enable",
      inspection: selected.inspect({
        source: encoder.encode(source),
        serverName: "invokta-support",
      }),
    });
    expect(patch.kind).toBe("changed");
    if (patch.kind !== "changed") return;
    const postText = decoder.decode(patch.postImage);
    expect(postText.endsWith("\n")).toBe(false);
    expect(postText).toContain(
      'note = """\r\nenabled = false\r\nheaders.Authorization = "inside-string"\r\n"""',
    );
    expect(postText).toContain(
      '# preserved top\r\nordinary = "enabled = false"',
    );
    expect(postText).toContain('[unrelated]\r\norder = "preserved"');
  });

  it("rejects malformed Grok parents, selected fields, duplicates, datetimes, and raw transport", () => {
    const selected = adapter("grok-build");
    for (const source of [
      "mcp_servers = false\n",
      "mcp_servers.invokta-support = 1979-05-27T07:32:00Z\n",
      '[mcp_servers.invokta-support]\ncommand = "x"\nenv = []\n',
      '[mcp_servers.invokta-support]\nurl = "x"\nheaders = []\n',
      '[mcp_servers.invokta-support]\ncommand = "x"\nenabled = "true"\n',
      '[mcp_servers.invokta-support]\ncommand = "x"\ntransport = "stdio"\n',
      '[mcp_servers.invokta-support]\ncommand = "x"\ncommand = "y"\n',
      '[mcp_servers.invokta-support]\nurl = "x"\nheaders = { X = "1", x = "2" }\n',
    ]) {
      expectInstallerCode(
        () =>
          selected.inspect({
            source: encoder.encode(source),
            serverName: "invokta-support",
          }),
        "HARNESS_CONFIG_INVALID",
      );
    }
  });

  it.each(["opencode-v2", "grok-build"] as const)(
    "rejects forged inspections and definitions that cannot satisfy the %s postcondition",
    (targetId) => {
      const selected = adapter(targetId);
      const definition = selected.descriptorToDefinition(stdioDescriptor([]));
      const absent = selected.inspect({
        source: undefined,
        serverName: "invokta-support",
      });
      expectInstallerCode(
        () =>
          selected.constructPatch({
            action: "install",
            definition: { ...definition, future: true },
            inspection: absent,
          }),
        "HARNESS_CONFIG_INVALID",
      );

      const installed = install(targetId, stdioDescriptor([]));
      const present = selected.inspect({
        source: installed,
        serverName: "invokta-support",
      });
      expectInstallerCode(
        () =>
          selected.constructPatch({
            action: "disable",
            inspection: forgeCurrentServer(present, {
              kind: "present",
              definition: { ...definition, command: "forged" },
            }),
          }),
        "HARNESS_CONFIG_INVALID",
      );
    },
  );

  it.each([
    {
      targetId: "opencode-v2" as const,
      source: (depth: number) =>
        encoder.encode(
          `{"nested":${"[".repeat(depth - 1)}0${"]".repeat(depth - 1)}}`,
        ),
    },
    {
      targetId: "grok-build" as const,
      source: (depth: number) =>
        encoder.encode(
          `value = ${"[".repeat(depth - 1)}0${"]".repeat(depth - 1)}\n`,
        ),
    },
  ])(
    "accepts depth 100 and rejects 101 before patching for $targetId",
    ({ targetId, source }) => {
      expect(
        adapter(targetId).inspect({
          source: source(100),
          serverName: "invokta-support",
        }).currentServer,
      ).toEqual({ kind: "absent" });
      const counters = createTargetAdapterCounters();
      expectInstallerCode(
        () =>
          adapter(targetId).inspect({
            source: source(101),
            serverName: "invokta-support",
            counters,
          }),
        "HARNESS_CONFIG_INVALID",
      );
      expect(counters.patchConstructionPasses).toBe(0);
    },
  );

  it.each(["opencode-v2", "grok-build"] as const)(
    "enforces UTF-8, BOM, source and post-image limits for %s",
    (targetId) => {
      const selected = adapter(targetId);
      for (const source of [
        new Uint8Array([0xc3, 0x28]),
        encoder.encode(
          targetId === "opencode-v2"
            ? '{"value":"\ufeff"}'
            : 'value = "\ufeff"\n',
        ),
        new Uint8Array(targetConfigByteLimit + 1),
      ]) {
        expectInstallerCode(
          () =>
            selected.inspect({
              source,
              serverName: "invokta-support",
            }),
          "HARNESS_CONFIG_INVALID",
        );
      }

      const definition = selected.descriptorToDefinition(stdioDescriptor([]));
      const baseText = targetId === "opencode-v2" ? "{}" : "theme = true";
      const base = encoder.encode(baseText);
      const growth =
        install(targetId, stdioDescriptor([]), base).byteLength -
        base.byteLength;
      const sourceLength = targetConfigByteLimit + 1 - growth;
      const source = encoder.encode(baseText.padEnd(sourceLength, " "));
      const counters = createTargetAdapterCounters();
      const inspection = selected.inspect({
        source,
        serverName: "invokta-support",
        counters,
      });
      expectInstallerCode(
        () =>
          selected.constructPatch({
            action: "install",
            definition,
            inspection,
            counters,
          }),
        "HARNESS_CONFIG_INVALID",
      );
      expect(counters.postImageEncodePasses).toBe(1);
      expect(counters.postImageDecodePasses).toBe(0);
      expect(counters.postImageParsePasses).toBe(0);
    },
  );

  it.each(["opencode-v2", "grok-build"] as const)(
    "accepts the inclusive source and post-image limits and preserves a leading BOM for %s",
    (targetId) => {
      const selected = adapter(targetId);
      const baseText = targetId === "opencode-v2" ? "{}" : "theme = true";
      const toggleText =
        targetId === "opencode-v2"
          ? '{"mcp":{"servers":{"invokta-support":{"type":"local","command":["support-engine-mcp","serve","--stdio"],"environment":{},"disabled":false}}}}'
          : '[mcp_servers.invokta-support]\ncommand = "support-engine-mcp"\nargs = ["serve", "--stdio"]\nenabled = false\n';
      const toggleAction = targetId === "opencode-v2" ? "disable" : "enable";
      const exactSource = encoder.encode(
        toggleText.padEnd(targetConfigByteLimit, " "),
      );
      expect(exactSource.byteLength).toBe(targetConfigByteLimit);
      const exactSourceCounters = createTargetAdapterCounters();
      const exactSourceInspection = selected.inspect({
        source: exactSource,
        serverName: "invokta-support",
        counters: exactSourceCounters,
      });
      const exactSourcePatch = selected.constructPatch({
        action: toggleAction,
        inspection: exactSourceInspection,
        counters: exactSourceCounters,
      });
      expect(exactSourcePatch.kind).toBe("changed");
      expect(exactSourceCounters).toEqual(singleFullPassCounters);

      const base = encoder.encode(baseText);
      const basePost = install(targetId, stdioDescriptor([]), base);
      const growth = basePost.byteLength - base.byteLength;
      const exactPostSource = encoder.encode(
        baseText.padEnd(targetConfigByteLimit - growth, " "),
      );
      const exactPostCounters = createTargetAdapterCounters();
      const exactPostInspection = selected.inspect({
        source: exactPostSource,
        serverName: "invokta-support",
        counters: exactPostCounters,
      });
      const exactPostPatch = selected.constructPatch({
        action: "install",
        definition: selected.descriptorToDefinition(stdioDescriptor([])),
        inspection: exactPostInspection,
        counters: exactPostCounters,
      });
      expect(exactPostPatch.kind).toBe("changed");
      if (exactPostPatch.kind !== "changed") {
        throw new Error("Expected an exact-limit post-image.");
      }
      expect(exactPostPatch.postImage.byteLength).toBe(targetConfigByteLimit);
      expect(exactPostCounters).toEqual(singleFullPassCounters);

      const bomPayload = encoder.encode(
        toggleText.padEnd(targetConfigByteLimit - 3, " "),
      );
      const exactWithBom = new Uint8Array(targetConfigByteLimit);
      exactWithBom.set([0xef, 0xbb, 0xbf]);
      exactWithBom.set(bomPayload, 3);
      const exactBomCounters = createTargetAdapterCounters();
      const exactBomInspection = selected.inspect({
        source: exactWithBom,
        serverName: "invokta-support",
        counters: exactBomCounters,
      });
      const exactBomPatch = selected.constructPatch({
        action: toggleAction,
        inspection: exactBomInspection,
        counters: exactBomCounters,
      });
      expect(exactBomPatch.kind).toBe("changed");
      if (exactBomPatch.kind !== "changed") {
        throw new Error("Expected an exact-limit BOM patch.");
      }
      expect([...exactBomPatch.postImage.slice(0, 3)]).toEqual([
        0xef, 0xbb, 0xbf,
      ]);
      expect(exactBomCounters).toEqual(singleFullPassCounters);
    },
    30_000,
  );

  it.each(["opencode-v2", "grok-build"] as const)(
    "counts one source and post-image pass and zero patch passes for idempotent %s toggles",
    (targetId) => {
      const selected = adapter(targetId);
      const source = install(targetId, stdioDescriptor([]));
      const counters = createTargetAdapterCounters();
      const inspection = selected.inspect({
        source,
        serverName: "invokta-support",
        counters,
      });
      const disabled = selected.constructPatch({
        action: "disable",
        inspection,
        counters,
      });
      expect(disabled.kind).toBe("changed");
      expect(counters).toEqual({
        sourceDecodePasses: 1,
        sourceParsePasses: 1,
        inspectionPasses: 1,
        patchConstructionPasses: 1,
        postImageEncodePasses: 1,
        postImageDecodePasses: 1,
        postImageParsePasses: 1,
      });
      if (disabled.kind !== "changed") return;
      const disabledInspection = selected.inspect({
        source: disabled.postImage,
        serverName: "invokta-support",
      });
      const unchangedCounters = createTargetAdapterCounters();
      expect(
        selected.constructPatch({
          action: "disable",
          inspection: disabledInspection,
          counters: unchangedCounters,
        }),
      ).toEqual({ kind: "unchanged" });
      expect(unchangedCounters.patchConstructionPasses).toBe(0);
    },
  );

  it("feeds OpenCode JSONC and GROK_HOME evidence into their matching adapters", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-opencode-"));
    temporaryDirectories.push(homeDirectory);
    const configPath = join(homeDirectory, ".config/opencode/opencode.jsonc");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      '{// selected sibling\n"mcp":{"servers":{"invokta-support":{"type":"local","command":["x"],},},},}',
    );
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: { get: () => undefined },
      fileSystem: createNodeFileSystem(),
    });
    const evidence = await probes["opencode-v2"]({
      homeDirectory,
      targetId: "opencode-v2",
    });
    expect(evidence).toEqual({ kind: "present", path: configPath });
    if (evidence.kind !== "present") return;
    expect(
      adapter("opencode-v2").inspect({
        source: readFileSync(evidence.path),
        serverName: "invokta-support",
      }).currentServer,
    ).toMatchObject({
      kind: "present",
      definition: { type: "local", command: ["x"], disabled: false },
    });

    const grokHome = join(homeDirectory, ".custom-grok");
    const grokPath = join(grokHome, "config.toml");
    mkdirSync(grokHome, { recursive: true });
    writeFileSync(
      grokPath,
      '[mcp_servers.invokta-support]\ncommand = "x"\nargs = []\n',
    );
    const grokProbes = createNodeTargetConfigEvidenceProbes({
      environment: {
        get: (name) => (name === "GROK_HOME" ? grokHome : undefined),
      },
      fileSystem: createNodeFileSystem(),
    });
    const grokEvidence = await grokProbes["grok-build"]({
      homeDirectory,
      targetId: "grok-build",
    });
    expect(grokEvidence).toEqual({ kind: "present", path: grokPath });
    if (grokEvidence.kind !== "present") return;
    expect(
      adapter("grok-build").inspect({
        source: readFileSync(grokEvidence.path),
        serverName: "invokta-support",
      }).currentServer,
    ).toMatchObject({
      kind: "present",
      definition: { command: "x", args: [], enabled: true },
    });
  });
});
