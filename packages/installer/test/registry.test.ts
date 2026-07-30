import { describe, expect, it, vi } from "vitest";

import type {
  CapabilityInstallDescriptor,
  RegistryCompatibilityAdapters,
  RegistryIssue,
} from "../src/registry.js";
import {
  configurationTargetIds,
  validateRegistryBytes,
} from "../src/registry.js";
import { registryCompatibilityAdapters } from "../src/target-adapters.js";

const encoder = new TextEncoder();

function stdioEntry(index = 0) {
  return {
    id: `support-engine-${index}`,
    version: "1.0.0",
    title: `Support Engine ${index}`,
    description: "Classify and route support tickets.",
    capabilityIds: [`support.classify-ticket-${index}`],
    server: {
      name: `invokta-support-${index}`,
      transport: {
        type: "stdio",
        command: "support-engine-mcp",
      },
    },
  };
}

function httpEntry(index = 0) {
  return {
    ...stdioEntry(index),
    server: {
      name: `invokta-support-${index}`,
      transport: {
        type: "streamable-http",
        url: "https://support.example.com/mcp",
      },
    },
  };
}

function document(entries: readonly unknown[]) {
  return { schemaVersion: 1, entries };
}

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function compatibilityAdapters(
  supported: (
    targetId: string,
    entry: CapabilityInstallDescriptor,
  ) => boolean = () => true,
) {
  const calls: Array<{ targetId: string; entryId: string }> = [];
  const adapters = Object.fromEntries(
    configurationTargetIds.map((targetId) => [
      targetId,
      vi.fn((entry: CapabilityInstallDescriptor) => {
        calls.push({ targetId, entryId: entry.id });
        return supported(targetId, entry)
          ? ({ supported: true } as const)
          : ({ supported: false, reason: "not-representable" } as const);
      }),
    ]),
  ) as unknown as RegistryCompatibilityAdapters;
  return { adapters, calls };
}

function validate(value: unknown) {
  const compatibility = compatibilityAdapters();
  return {
    compatibility,
    result: validateRegistryBytes(bytes(value), compatibility.adapters),
  };
}

function issues(value: unknown): readonly RegistryIssue[] {
  const result = validate(value).result;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected registry validation to fail.");
  return result.issues;
}

function expectIssue(
  value: unknown,
  pointer: string,
  code?: RegistryIssue["code"],
) {
  const result = issues(value);
  expect(result).toContainEqual(
    code === undefined
      ? expect.objectContaining({ pointer })
      : { pointer, code },
  );
}

describe("local capability registry", () => {
  it("defines exactly the eleven compatibility targets", () => {
    expect(configurationTargetIds).toEqual([
      "antigravity",
      "claude-code",
      "claude-desktop",
      "codex",
      "cursor",
      "grok-build",
      "hermes",
      "kimi-code",
      "openclaw",
      "opencode-v2",
      "vscode",
    ]);
  });

  it("accepts and canonically normalizes both transports", () => {
    const entry = httpEntry();
    entry.title = "\u{10000}";
    entry.server.transport = {
      type: "streamable-http",
      url: "https://SUPPORT.EXAMPLE.COM:443/mcp",
      authentication: { type: "bearer-env", variable: "SUPPORT_TOKEN" },
      headersFromEnv: {
        "X-Zeta": "ZETA_VALUE",
        "x-Alpha": "ALPHA_VALUE",
      },
    } as typeof entry.server.transport;
    const earlierByCodePoint = stdioEntry(1);
    earlierByCodePoint.title = "\uE000";
    const compatibility = compatibilityAdapters(
      (targetId) => targetId !== "antigravity",
    );

    const result = validateRegistryBytes(
      bytes(document([entry, earlierByCodePoint])),
      compatibility.adapters,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected a valid registry.");
    expect(
      result.registry.entries.map(({ descriptor }) => descriptor.id),
    ).toEqual([earlierByCodePoint.id, entry.id]);
    const normalizedStdio =
      result.registry.entries[0]?.descriptor.server.transport;
    expect(normalizedStdio).toEqual({
      type: "stdio",
      command: "support-engine-mcp",
      args: [],
      forwardEnv: [],
    });
    const normalizedHttp =
      result.registry.entries[1]?.descriptor.server.transport;
    expect(normalizedHttp).toEqual({
      type: "streamable-http",
      url: "https://support.example.com/mcp",
      authentication: { type: "bearer-env", variable: "SUPPORT_TOKEN" },
      headersFromEnv: {
        "x-alpha": "ALPHA_VALUE",
        "x-zeta": "ZETA_VALUE",
      },
    });
    expect(result.registry.entries[1]?.compatibility.antigravity).toEqual({
      supported: false,
      reason: "not-representable",
    });
    expect(Object.isFrozen(result.registry)).toBe(true);
    expect(Object.isFrozen(result.registry.entries)).toBe(true);
    expect(Object.isFrozen(result.registry.entries[1]?.descriptor)).toBe(true);
    expect(compatibility.calls).toHaveLength(22);
  });

  it("uses the stable id as the display-order tie breaker", () => {
    const second = stdioEntry(2);
    second.id = "z-engine";
    second.title = "Same";
    const first = stdioEntry(1);
    first.id = "a-engine";
    first.title = "Same";

    const { result } = validate(document([second, first]));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected a valid registry.");
    expect(
      result.registry.entries.map(({ descriptor }) => descriptor.id),
    ).toEqual(["a-engine", "z-engine"]);
  });

  it("accepts exactly 1,000 entries and calls every one of eleven adapters once", () => {
    const entries = Array.from({ length: 1_000 }, (_, index) =>
      stdioEntry(index),
    );
    const compatibility = compatibilityAdapters();
    const counters = {
      pathLinksCreated: 0,
      pathSegmentsRendered: 0,
      entryValidationPasses: 0,
      compatibilityCalls: 0,
    };

    const result = validateRegistryBytes(
      bytes(document(entries)),
      compatibility.adapters,
      counters,
    );

    expect(result.ok).toBe(true);
    expect(counters.entryValidationPasses).toBe(1_000);
    expect(counters.compatibilityCalls).toBe(11_000);
    expect(compatibility.calls).toHaveLength(11_000);
    for (const adapter of Object.values(compatibility.adapters)) {
      expect(adapter).toHaveBeenCalledTimes(1_000);
    }
  });

  it("runs the 11,000-call boundary through all eleven shipping adapters", () => {
    const counters = {
      pathLinksCreated: 0,
      pathSegmentsRendered: 0,
      entryValidationPasses: 0,
      compatibilityCalls: 0,
    };
    const result = validateRegistryBytes(
      bytes(
        document(
          Array.from({ length: 1_000 }, (_, index) => stdioEntry(index)),
        ),
      ),
      registryCompatibilityAdapters,
      counters,
    );

    expect(result.ok).toBe(true);
    expect(counters).toMatchObject({
      entryValidationPasses: 1_000,
      compatibilityCalls: 11_000,
    });
  });

  it("uses linear path work for a deeply nested valid unknown subtree", () => {
    const depth = 10_000;
    const nested = `${'{"node":'.repeat(depth)}"leaf"${"}".repeat(depth)}`;
    const source = `{"schemaVersion":1,"entries":[],"unknown":${nested}}`;
    const compatibility = compatibilityAdapters();
    const counters = {
      pathLinksCreated: 0,
      pathSegmentsRendered: 0,
      entryValidationPasses: 0,
      compatibilityCalls: 0,
    };

    const result = validateRegistryBytes(
      encoder.encode(source),
      compatibility.adapters,
      counters,
    );

    expect(result).toEqual({
      ok: false,
      issues: [{ pointer: "/unknown", code: "UNKNOWN_KEY" }],
    });
    expect(counters).toEqual({
      pathLinksCreated: 2 * depth + 7,
      pathSegmentsRendered: 1,
      entryValidationPasses: 0,
      compatibilityCalls: 0,
    });
  });

  it("rejects entry count 1,001 before compatibility checks", () => {
    const entries = Array.from({ length: 1_001 }, (_, index) =>
      stdioEntry(index),
    );
    const compatibility = compatibilityAdapters();

    const result = validateRegistryBytes(
      bytes(document(entries)),
      compatibility.adapters,
    );

    expect(result.ok).toBe(false);
    expect(compatibility.calls).toHaveLength(0);
    if (result.ok) throw new Error("Expected registry validation to fail.");
    expect(result.issues).toContainEqual({
      pointer: "/entries",
      code: "ARRAY_TOO_LONG",
    });
  });

  it("accepts exactly 1 MiB and rejects the next encoded byte before decoding", () => {
    const raw = JSON.stringify(document([]));
    const inclusive = encoder.encode(
      `${raw}${" ".repeat(1_048_576 - encoder.encode(raw).byteLength)}`,
    );
    const compatibility = compatibilityAdapters();

    expect(validateRegistryBytes(inclusive, compatibility.adapters).ok).toBe(
      true,
    );
    const exclusive = new Uint8Array(1_048_577);
    exclusive.set(inclusive);
    exclusive[exclusive.length - 1] = 0x20;
    const rejected = validateRegistryBytes(exclusive, compatibility.adapters);

    expect(rejected).toEqual({
      ok: false,
      issues: [{ pointer: "", code: "REGISTRY_TOO_LARGE" }],
    });
  });

  it("rejects malformed UTF-8, a leading BOM, and malformed JSON", () => {
    const compatibility = compatibilityAdapters();
    const malformedUtf8 = Uint8Array.from([0x7b, 0x22, 0x80, 0x22, 0x7d]);
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes(document([]))]);

    expect(
      validateRegistryBytes(malformedUtf8, compatibility.adapters),
    ).toEqual({
      ok: false,
      issues: [{ pointer: "", code: "INVALID_UTF8" }],
    });
    expect(validateRegistryBytes(bom, compatibility.adapters)).toEqual({
      ok: false,
      issues: [{ pointer: "", code: "BOM_FORBIDDEN" }],
    });
    expect(
      validateRegistryBytes(
        encoder.encode("{not-json}"),
        compatibility.adapters,
      ),
    ).toEqual({
      ok: false,
      issues: [{ pointer: "", code: "INVALID_JSON" }],
    });
  });

  it("detects duplicate object keys at their escaped JSON pointers", () => {
    const raw = `{"schemaVersion":1,"entries":[{"id":"one","id":"two","version":"1","title":"Title","description":"Description","capabilityIds":["cap"],"server":{"name":"server","transport":{"type":"stdio","command":"command"}}}],"a/b":{"~key":1,"~key":2}}`;
    const result = validateRegistryBytes(
      encoder.encode(raw),
      compatibilityAdapters().adapters,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected registry validation to fail.");
    expect(result.issues).toContainEqual({
      pointer: "/entries/0/id",
      code: "DUPLICATE_KEY",
    });
    expect(result.issues).toContainEqual({
      pointer: "/a~1b/~0key",
      code: "DUPLICATE_KEY",
    });
  });

  it.each([
    ["root", { ...document([]), unexpected: true }, "/unexpected"],
    ["entry", { ...stdioEntry(), unexpected: true }, "/entries/0/unexpected"],
    [
      "server",
      { ...stdioEntry(), server: { ...stdioEntry().server, unexpected: true } },
      "/entries/0/server/unexpected",
    ],
    [
      "transport",
      {
        ...stdioEntry(),
        server: {
          ...stdioEntry().server,
          transport: {
            ...stdioEntry().server.transport,
            cwd: "/private",
          },
        },
      },
      "/entries/0/server/transport/cwd",
    ],
    [
      "authentication",
      {
        ...httpEntry(),
        server: {
          ...httpEntry().server,
          transport: {
            ...httpEntry().server.transport,
            authentication: { type: "none", token: "secret-marker" },
          },
        },
      },
      "/entries/0/server/transport/authentication/token",
    ],
  ])(
    "rejects unknown keys in the closed %s object",
    (_name, value, pointer) => {
      const registry = _name === "root" ? value : document([value]);
      const found = issues(registry);

      expect(found).toContainEqual({ pointer, code: "UNKNOWN_KEY" });
      expect(JSON.stringify(found)).not.toContain("secret-marker");
      expect(JSON.stringify(found)).not.toContain("/private");
    },
  );

  it("aggregates issues in deterministic JSON-pointer order without values", () => {
    const entry = stdioEntry();
    entry.id = "INVALID SECRET ID";
    entry.version = " ";
    entry.description = " ";
    entry.capabilityIds = ["", ""];
    entry.server.name = "INVALID SECRET NAME";

    const first = issues(document([entry]));
    const second = issues(document([entry]));

    expect(first).toEqual(second);
    expect(first.map(({ pointer }) => pointer)).toEqual(
      [...first.map(({ pointer }) => pointer)].sort(),
    );
    expect(JSON.stringify(first)).not.toContain("INVALID SECRET");
  });

  it("orders issue pointers by Unicode code point instead of UTF-16 units", () => {
    const found = issues({
      schemaVersion: 1,
      entries: [],
      "\u{10000}": true,
      "\uE000": true,
    });

    expect(found.map(({ pointer }) => pointer)).toEqual([
      "/\uE000",
      "/\u{10000}",
    ]);
  });

  it("requires the exact root schema and all descriptor fields", () => {
    expectIssue(
      { schemaVersion: 2, entries: [] },
      "/schemaVersion",
      "INVALID_SCHEMA_VERSION",
    );
    expectIssue({ schemaVersion: 1, entries: {} }, "/entries", "INVALID_TYPE");

    const entry = stdioEntry() as unknown as Record<string, unknown>;
    delete entry.description;
    expectIssue(document([entry]), "/entries/0/description", "REQUIRED");
  });

  it.each([
    ["id", "", "/entries/0/id"],
    ["id", `a${"a".repeat(128)}`, "/entries/0/id"],
    ["version", " ", "/entries/0/version"],
    ["title", " ", "/entries/0/title"],
    ["description", " ", "/entries/0/description"],
  ])("rejects invalid %s metadata", (field, value, pointer) => {
    const entry = stdioEntry() as Record<string, unknown>;
    entry[field] = value;
    expectIssue(document([entry]), pointer);
  });

  it("enforces scalar limits inclusively", () => {
    const accepted = stdioEntry();
    accepted.id = `a${"a".repeat(127)}`;
    accepted.version = "v".repeat(4_096);
    accepted.title = "t".repeat(120);
    accepted.description = "d".repeat(1_000);
    accepted.capabilityIds = ["c".repeat(4_096)];
    accepted.server.name = `s${"s".repeat(63)}`;
    expect(validate(document([accepted])).result.ok).toBe(true);

    const cases: Array<[keyof typeof accepted, string, string]> = [
      ["version", "v".repeat(4_097), "/entries/0/version"],
      ["title", "t".repeat(121), "/entries/0/title"],
      ["description", "d".repeat(1_001), "/entries/0/description"],
    ];
    for (const [field, value, pointer] of cases) {
      const entry = stdioEntry();
      (entry as unknown as Record<string, unknown>)[field] = value;
      expectIssue(document([entry]), pointer, "STRING_TOO_LONG");
    }
  });

  it("rejects invalid server names, blank capability IDs, and invalid stdio commands", () => {
    const invalidServer = stdioEntry();
    invalidServer.server.name = "Invalid Server";
    expectIssue(
      document([invalidServer]),
      "/entries/0/server/name",
      "INVALID_SERVER_NAME",
    );

    const blankCapability = stdioEntry();
    blankCapability.capabilityIds = [" "];
    expectIssue(
      document([blankCapability]),
      "/entries/0/capabilityIds/0",
      "EMPTY_STRING",
    );

    const emptyCommand = stdioEntry();
    emptyCommand.server.transport.command = "";
    expectIssue(
      document([emptyCommand]),
      "/entries/0/server/transport/command",
      "EMPTY_STRING",
    );

    const nulCommand = stdioEntry();
    nulCommand.server.transport.command = "command\u0000argument";
    expectIssue(
      document([nulCommand]),
      "/entries/0/server/transport/command",
      "NUL_FORBIDDEN",
    );
  });

  it("rejects lone surrogates and counts Unicode scalar values instead of UTF-16 units", () => {
    const valid = stdioEntry();
    valid.version = "\u{10000}".repeat(4_096);
    expect(validate(document([valid])).result.ok).toBe(true);

    const invalid = stdioEntry();
    invalid.version = "\uD800";
    expectIssue(document([invalid]), "/entries/0/version", "INVALID_UNICODE");
  });

  it("enforces capability, argument, and environment count and uniqueness rules", () => {
    const accepted = stdioEntry();
    accepted.capabilityIds = Array.from(
      { length: 100 },
      (_, index) => `cap-${index}`,
    );
    const acceptedTransport = {
      type: "stdio",
      command: "command",
      args: Array.from({ length: 128 }, (_, index) => `arg-${index}`),
      forwardEnv: Array.from({ length: 64 }, (_, index) => `ENV_${index}`),
    };
    accepted.server.transport = acceptedTransport;
    expect(validate(document([accepted])).result.ok).toBe(true);

    const noCapabilities = stdioEntry();
    noCapabilities.capabilityIds = [];
    expectIssue(
      document([noCapabilities]),
      "/entries/0/capabilityIds",
      "ARRAY_TOO_SHORT",
    );

    const duplicateCapabilities = stdioEntry();
    duplicateCapabilities.capabilityIds = ["cap", "cap"];
    expectIssue(
      document([duplicateCapabilities]),
      "/entries/0/capabilityIds/1",
      "DUPLICATE_VALUE",
    );

    const invalidEnv = stdioEntry();
    const invalidEnvironmentTransport = {
      type: "stdio",
      command: "command",
      forwardEnv: ["TOKEN", "TOKEN", "lowercase"],
    };
    invalidEnv.server.transport = invalidEnvironmentTransport;
    const invalidEnvIssues = issues(document([invalidEnv]));
    expect(invalidEnvIssues).toContainEqual({
      pointer: "/entries/0/server/transport/forwardEnv/1",
      code: "DUPLICATE_VALUE",
    });
    expect(invalidEnvIssues).toContainEqual({
      pointer: "/entries/0/server/transport/forwardEnv/2",
      code: "INVALID_ENV_NAME",
    });

    for (const [field, values, pointer] of [
      [
        "capabilityIds",
        Array.from({ length: 101 }, (_, i) => `cap-${i}`),
        "/entries/0/capabilityIds",
      ],
      [
        "args",
        Array.from({ length: 129 }, (_, i) => `arg-${i}`),
        "/entries/0/server/transport/args",
      ],
      [
        "forwardEnv",
        Array.from({ length: 65 }, (_, i) => `ENV_${i}`),
        "/entries/0/server/transport/forwardEnv",
      ],
    ] as const) {
      const entry = stdioEntry();
      if (field === "capabilityIds") entry.capabilityIds = [...values];
      else
        entry.server.transport = {
          ...entry.server.transport,
          [field]: [...values],
        };
      expectIssue(document([entry]), pointer, "ARRAY_TOO_LONG");
    }
  });

  it("rejects duplicate entry and server identities", () => {
    const first = stdioEntry(1);
    const second = stdioEntry(2);
    second.id = first.id;
    second.server.name = first.server.name;

    const found = issues(document([first, second]));

    expect(found).toContainEqual({
      pointer: "/entries/1/id",
      code: "DUPLICATE_ID",
    });
    expect(found).toContainEqual({
      pointer: "/entries/1/server/name",
      code: "DUPLICATE_SERVER_NAME",
    });
  });

  it.each([
    ["/mcp", "INVALID_URL"],
    ["ftp://support.example.com/mcp", "INVALID_URL"],
    ["http://support.example.com/mcp", "INSECURE_URL"],
    ["http://127.0.0.01/mcp", "INSECURE_URL"],
    ["https://@support.example.com/mcp", "CREDENTIAL_URL"],
    ["https://user:password@support.example.com/mcp", "CREDENTIAL_URL"],
    ["https://support.example.com/other", "INVALID_URL"],
    ["https:///mcp", "INVALID_URL"],
    ["http:///mcp", "INVALID_URL"],
    ["https:////mcp", "INVALID_URL"],
    ["https://support.example.com/./mcp", "INVALID_URL"],
    ["https://support.example.com//mcp", "INVALID_URL"],
    ["https://support.example.com/a/../mcp", "INVALID_URL"],
    ["https://support.example.com/%2e%2e/mcp", "INVALID_URL"],
    ["https://support.example.com/%6dcp", "INVALID_URL"],
    ["https://support.example.com/m%63p", "INVALID_URL"],
    ["https://support.example.com/%2Fmcp", "INVALID_URL"],
    ["https://support.example.com/mcp?", "INVALID_URL"],
    ["https://support.example.com/mcp?token=secret", "INVALID_URL"],
    ["https://support.example.com/mcp#", "INVALID_URL"],
    ["https://support.example.com/mcp#fragment", "INVALID_URL"],
  ] as const)("rejects the HTTP URL %s", (url, code) => {
    const entry = httpEntry();
    entry.server.transport.url = url;
    expectIssue(document([entry]), "/entries/0/server/transport/url", code);
  });

  it.each([
    "https://support.example.com/mcp",
    "http://127.0.0.1:3000/mcp",
    "http://[::1]:3000/mcp",
  ])("accepts the HTTP URL %s", (url) => {
    const entry = httpEntry();
    entry.server.transport.url = url;
    expect(validate(document([entry])).result.ok).toBe(true);
  });

  it("enforces authentication and header rules without storing literal header values", () => {
    const entry = httpEntry();
    entry.server.transport = {
      type: "streamable-http",
      url: "https://support.example.com/mcp",
      authentication: { type: "bearer-env", variable: "support-token" },
      headersFromEnv: {
        "X-Header": "HEADER_VALUE",
        "x-header": "OTHER_VALUE",
        Authorization: "AUTH_VALUE",
        Host: "HOST_VALUE",
        "bad header": "BAD_VALUE",
      },
    } as typeof entry.server.transport;

    const found = issues(document([entry]));

    expect(found).toContainEqual({
      pointer: "/entries/0/server/transport/authentication/variable",
      code: "INVALID_ENV_NAME",
    });
    expect(found).toContainEqual({
      pointer: "/entries/0/server/transport/headersFromEnv/x-header",
      code: "DUPLICATE_HEADER",
    });
    expect(found).toContainEqual({
      pointer: "/entries/0/server/transport/headersFromEnv/Authorization",
      code: "RESERVED_HEADER",
    });
    expect(found).toContainEqual({
      pointer: "/entries/0/server/transport/headersFromEnv/Host",
      code: "RESERVED_HEADER",
    });
    expect(found).toContainEqual({
      pointer: "/entries/0/server/transport/headersFromEnv/bad header",
      code: "INVALID_HEADER_NAME",
    });
    expect(JSON.stringify(found)).not.toContain("_VALUE");
  });

  it("rejects every transport-controlled HTTP header", () => {
    const reserved = [
      "Host",
      "Content-Length",
      "Connection",
      "Keep-Alive",
      "Proxy-Authenticate",
      "Proxy-Authorization",
      "TE",
      "Trailer",
      "Transfer-Encoding",
      "Upgrade",
    ] as const;
    const entry = httpEntry();
    entry.server.transport = {
      ...entry.server.transport,
      headersFromEnv: Object.fromEntries(
        reserved.map((name, index) => [name, `VALUE_${index}`]),
      ),
    } as typeof entry.server.transport;

    const found = issues(document([entry]));

    for (const name of reserved) {
      expect(found).toContainEqual({
        pointer: `/entries/0/server/transport/headersFromEnv/${name}`,
        code: "RESERVED_HEADER",
      });
    }
  });

  it("accepts 64 safe headers and rejects the sixty-fifth", () => {
    const accepted = httpEntry();
    const acceptedHeaders = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `X-Header-${index}`,
        `VALUE_${index}`,
      ]),
    );
    accepted.server.transport = {
      ...accepted.server.transport,
      headersFromEnv: acceptedHeaders,
    } as typeof accepted.server.transport;
    expect(validate(document([accepted])).result.ok).toBe(true);

    const rejected = httpEntry();
    rejected.server.transport = {
      ...rejected.server.transport,
      headersFromEnv: {
        ...acceptedHeaders,
        "X-Header-64": "VALUE_64",
      },
    } as typeof rejected.server.transport;
    expectIssue(
      document([rejected]),
      "/entries/0/server/transport/headersFromEnv",
      "OBJECT_TOO_LARGE",
    );
  });

  it("rejects missing, malformed, and mixed transport definitions", () => {
    const missing = stdioEntry();
    (missing.server as unknown as Record<string, unknown>).transport = {};
    expectIssue(
      document([missing]),
      "/entries/0/server/transport/type",
      "REQUIRED",
    );

    const mixed = httpEntry();
    (mixed.server.transport as unknown as Record<string, unknown>).command =
      "command";
    expectIssue(
      document([mixed]),
      "/entries/0/server/transport/command",
      "UNKNOWN_KEY",
    );

    const unknown = stdioEntry();
    unknown.server.transport.type = "sse";
    expectIssue(
      document([unknown]),
      "/entries/0/server/transport/type",
      "INVALID_TRANSPORT",
    );
  });

  it("keeps partial compatibility valid and rejects support by no target", () => {
    const partial = compatibilityAdapters((targetId) => targetId === "codex");
    const partialResult = validateRegistryBytes(
      bytes(document([stdioEntry()])),
      partial.adapters,
    );
    expect(partialResult.ok).toBe(true);
    expect(partial.calls).toHaveLength(11);

    const unsupported = compatibilityAdapters(() => false);
    const unsupportedResult = validateRegistryBytes(
      bytes(document([stdioEntry()])),
      unsupported.adapters,
    );
    expect(unsupportedResult.ok).toBe(false);
    expect(unsupported.calls).toHaveLength(11);
    if (unsupportedResult.ok) throw new Error("Expected validation to fail.");
    expect(unsupportedResult.issues).toContainEqual({
      pointer: "/entries/0/server/transport",
      code: "UNSUPPORTED_BY_ALL_TARGETS",
    });
  });
});
