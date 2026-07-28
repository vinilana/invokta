import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type DeployManifestIssue,
  type DeployManifestIssueReason,
  type DeployManifestResult,
  deployManifestDefaults,
  deployManifestFileName,
  deployManifestIssueMessages,
  deployManifestLimits,
  environmentNamePattern,
  loadDeployManifest,
  parseDeployManifest,
  toDeployError,
} from "../src/manifest.js";

const secret = "sentinel-value-that-must-never-be-echoed";

function parse(document: unknown): DeployManifestResult {
  return parseDeployManifest(JSON.stringify(document));
}

function accepted(document: unknown) {
  const result = parse(document);
  if (!result.ok) {
    throw new Error(
      `expected an accepted manifest, got ${JSON.stringify(result.issues)}`,
    );
  }
  return result.manifest;
}

function rejected(document: unknown): readonly DeployManifestIssue[] {
  const result = parse(document);
  if (result.ok) throw new Error("expected the manifest to be rejected");
  expect(result.code).toBe("MANIFEST_INVALID");
  return result.issues;
}

function onlyIssue(document: unknown): DeployManifestIssue {
  const issues = rejected(document);
  expect(issues).toHaveLength(1);
  return issues[0] as DeployManifestIssue;
}

function base(overrides: Readonly<Record<string, unknown>> = {}) {
  return { schemaVersion: 1, entry: "dist/mcp-http.js", ...overrides };
}

function repeat(unit: string, count: number): string {
  return unit.repeat(count);
}

describe("manifest constants", () => {
  it("pins the specified file name, limits, and defaults", () => {
    expect(deployManifestFileName).toBe("ai-engine.deploy.json");
    expect(deployManifestLimits).toEqual({
      maxEncodedBytes: 65_536,
      maxEnvironmentNames: 64,
      maxStringScalars: 1_024,
    });
    expect(deployManifestDefaults).toEqual({
      baseImage: "node:22-slim",
      expect: "alive",
      port: 3000,
    });
    expect(environmentNamePattern.source).toBe("^[A-Z_][A-Z0-9_]{0,127}$");
    expect(Object.isFrozen(deployManifestLimits)).toBe(true);
    expect(Object.isFrozen(deployManifestDefaults)).toBe(true);
    expect(Object.isFrozen(deployManifestIssueMessages)).toBe(true);
  });
});

describe("parseDeployManifest defaults", () => {
  it("applies every documented default to a minimal manifest", () => {
    const manifest = accepted(base());

    expect(manifest).toEqual({
      schemaVersion: 1,
      entry: "dist/mcp-http.js",
      env: { required: [], optional: [] },
      image: { baseImage: "node:22-slim", port: 3000 },
      healthcheck: { expect: "alive" },
    });
    expect(Object.hasOwn(manifest.healthcheck, "bearerEnv")).toBe(false);
  });

  it("preserves declared values and declaration order", () => {
    const manifest = accepted(
      base({
        entry: "./build/http.mjs",
        env: { required: ["B_TOKEN", "A_TOKEN"], optional: ["C_URL"] },
        image: { baseImage: "node:22-alpine", port: 8080 },
        healthcheck: { expect: "ready", bearerEnv: "PROBE_TOKEN" },
      }),
    );

    expect(manifest).toEqual({
      schemaVersion: 1,
      entry: "./build/http.mjs",
      env: { required: ["B_TOKEN", "A_TOKEN"], optional: ["C_URL"] },
      image: { baseImage: "node:22-alpine", port: 8080 },
      healthcheck: { expect: "ready", bearerEnv: "PROBE_TOKEN" },
    });
  });

  it("returns a deeply frozen manifest", () => {
    const manifest = accepted(base({ env: { required: ["A_TOKEN"] } }));

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.env)).toBe(true);
    expect(Object.isFrozen(manifest.env.required)).toBe(true);
    expect(Object.isFrozen(manifest.image)).toBe(true);
    expect(Object.isFrozen(manifest.healthcheck)).toBe(true);
  });
});

describe("parseDeployManifest document gate", () => {
  it("accepts a document of exactly the maximum encoded size", () => {
    const document = JSON.stringify(base());
    const padded = document + repeat(" ", 65_536 - document.length);

    expect(padded).toHaveLength(65_536);
    expect(parseDeployManifest(padded).ok).toBe(true);
  });

  it("rejects a document one byte over the maximum", () => {
    const document = JSON.stringify(base());
    const padded = document + repeat(" ", 65_537 - document.length);

    const result = parseDeployManifest(padded);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { pointer: "", reason: "DOCUMENT_TOO_LARGE" },
    ]);
  });

  it("measures encoded bytes rather than code units", () => {
    // "é" occupies two encoded bytes, so a document within the code-unit
    // budget can still exceed the byte budget.
    const document = JSON.stringify(base({ image: { baseImage: "nodé:22" } }));
    const padded = document + repeat(" ", 65_536 - document.length);

    expect(padded).toHaveLength(65_536);
    expect(new TextEncoder().encode(padded)).toHaveLength(65_537);
    expect(parseDeployManifest(padded)).toEqual({
      ok: false,
      code: "MANIFEST_INVALID",
      issues: [{ pointer: "", reason: "DOCUMENT_TOO_LARGE" }],
    });
  });

  it.each([
    ["", "DOCUMENT_NOT_JSON"],
    ["{", "DOCUMENT_NOT_JSON"],
    ['{"schemaVersion":1,}', "DOCUMENT_NOT_JSON"],
    ["[]", "OBJECT_REQUIRED"],
    ["null", "OBJECT_REQUIRED"],
    ["1", "OBJECT_REQUIRED"],
    ['"text"', "OBJECT_REQUIRED"],
  ])("rejects the document %j with %s", (text, reason) => {
    const result = parseDeployManifest(text);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([{ pointer: "", reason }]);
  });
});

describe("parseDeployManifest schemaVersion gate", () => {
  it.each([
    [{ entry: "dist/a.js" }, "KEY_REQUIRED"],
    [{ schemaVersion: 2, entry: "dist/a.js" }, "SCHEMA_VERSION_UNSUPPORTED"],
    [{ schemaVersion: "1", entry: "dist/a.js" }, "SCHEMA_VERSION_UNSUPPORTED"],
    [
      { schemaVersion: 1.0001, entry: "dist/a.js" },
      "SCHEMA_VERSION_UNSUPPORTED",
    ],
    [{ schemaVersion: null, entry: "dist/a.js" }, "SCHEMA_VERSION_UNSUPPORTED"],
  ])("rejects %j with %s", (document, reason) => {
    expect(onlyIssue(document)).toEqual({
      pointer: "/schemaVersion",
      reason,
    });
  });

  it("reports the schema version alone, because no other schema applies", () => {
    expect(onlyIssue({ schemaVersion: 2, unknown: true, entry: 42 })).toEqual({
      pointer: "/schemaVersion",
      reason: "SCHEMA_VERSION_UNSUPPORTED",
    });
  });
});

describe("parseDeployManifest closed schema", () => {
  it.each([
    [base({ unknown: true }), "/unknown"],
    [base({ env: { required: [], unknown: true } }), "/env/unknown"],
    [base({ image: { unknown: true } }), "/image/unknown"],
    [base({ healthcheck: { unknown: true } }), "/healthcheck/unknown"],
  ])("rejects an unknown key at %#", (document, pointer) => {
    expect(onlyIssue(document)).toEqual({ pointer, reason: "UNKNOWN_KEY" });
  });

  it("escapes a pointer segment per RFC 6901", () => {
    expect(onlyIssue(base({ "a/b~c": true }))).toEqual({
      pointer: "/a~1b~0c",
      reason: "UNKNOWN_KEY",
    });
  });

  it.each([
    [base({ env: [] }), "/env"],
    [base({ env: null }), "/env"],
    [base({ image: "node" }), "/image"],
    [base({ healthcheck: 1 }), "/healthcheck"],
  ])("requires an object at %s", (document, pointer) => {
    expect(onlyIssue(document)).toEqual({ pointer, reason: "OBJECT_REQUIRED" });
  });
});

describe("parseDeployManifest entry", () => {
  it.each([
    ["a.js"],
    ["./a.js"],
    ["dist/mcp-http.js"],
    ["dist/mcp-http.mjs"],
    ["dist/./nested/http.js"],
  ])("accepts the entry %j", (entry) => {
    expect(accepted(base({ entry })).entry).toBe(entry);
  });

  it.each([
    [{ schemaVersion: 1 }, "KEY_REQUIRED"],
    [base({ entry: 42 }), "STRING_REQUIRED"],
    [base({ entry: null }), "STRING_REQUIRED"],
    [base({ entry: "" }), "STRING_EMPTY"],
    [base({ entry: "dist/a\u0000.js" }), "STRING_HAS_NUL"],
    [base({ entry: "/dist/a.js" }), "ENTRY_ABSOLUTE"],
    [base({ entry: "\\dist\\a.js" }), "ENTRY_ABSOLUTE"],
    [base({ entry: "C:/dist/a.js" }), "ENTRY_ABSOLUTE"],
    [base({ entry: "../a.js" }), "ENTRY_ESCAPES_PROJECT"],
    [base({ entry: "dist/../../a.js" }), "ENTRY_ESCAPES_PROJECT"],
    [base({ entry: "dist\\..\\..\\a.js" }), "ENTRY_ESCAPES_PROJECT"],
    [base({ entry: "dist//a.js" }), "ENTRY_SEGMENT_EMPTY"],
    [base({ entry: "dist/" }), "ENTRY_SEGMENT_EMPTY"],
    [base({ entry: "dist/a.ts" }), "ENTRY_EXTENSION_UNSUPPORTED"],
    [base({ entry: "dist/a.cjs" }), "ENTRY_EXTENSION_UNSUPPORTED"],
    [base({ entry: "dist/a.JS" }), "ENTRY_EXTENSION_UNSUPPORTED"],
    [base({ entry: "dist/ajs" }), "ENTRY_EXTENSION_UNSUPPORTED"],
  ])("rejects %# with %s", (document, reason) => {
    expect(onlyIssue(document)).toEqual({ pointer: "/entry", reason });
  });

  it("accepts an entry of exactly the maximum string length", () => {
    const entry = `dist/${repeat("a", 1_016)}.js`;

    expect(entry).toHaveLength(1_024);
    expect(accepted(base({ entry })).entry).toBe(entry);
  });

  it("rejects an entry one scalar value over the maximum", () => {
    const entry = `dist/${repeat("a", 1_017)}.js`;

    expect(onlyIssue(base({ entry }))).toEqual({
      pointer: "/entry",
      reason: "STRING_TOO_LONG",
    });
  });
});

describe("parseDeployManifest environment names", () => {
  it.each([["A"], ["_"], ["_A0"], ["AI_ENGINE_HTTP_PORT"], [repeat("A", 128)]])(
    "accepts the name %j",
    (name) => {
      expect(
        accepted(base({ env: { required: [name] } })).env.required,
      ).toEqual([name]);
    },
  );

  it.each([
    [""],
    ["0A"],
    ["a"],
    ["A-B"],
    ["A.B"],
    ["A B"],
    ["Á"],
    [repeat("A", 129)],
  ])("rejects the name %j", (name) => {
    expect(onlyIssue(base({ env: { optional: [name] } }))).toEqual({
      pointer: "/env/optional/0",
      reason: "ENVIRONMENT_NAME_INVALID",
    });
  });

  it.each([
    [base({ env: { required: "A_TOKEN" } }), "/env/required", "ARRAY_REQUIRED"],
    [base({ env: { optional: {} } }), "/env/optional", "ARRAY_REQUIRED"],
    [base({ env: { required: [1] } }), "/env/required/0", "STRING_REQUIRED"],
    [
      base({ env: { required: ["A\u0000"] } }),
      "/env/required/0",
      "STRING_HAS_NUL",
    ],
  ])("rejects %# at %s with %s", (document, pointer, reason) => {
    expect(onlyIssue(document)).toEqual({ pointer, reason });
  });

  it("reports a duplicate at its later declaration", () => {
    expect(
      onlyIssue(
        base({ env: { required: ["A_TOKEN"], optional: ["A_TOKEN"] } }),
      ),
    ).toEqual({
      pointer: "/env/optional/0",
      reason: "ENVIRONMENT_NAME_DUPLICATE",
    });
    expect(
      onlyIssue(base({ env: { required: ["A_TOKEN", "A_TOKEN"] } })),
    ).toEqual({
      pointer: "/env/required/1",
      reason: "ENVIRONMENT_NAME_DUPLICATE",
    });
  });

  it("accepts exactly the maximum number of declared names", () => {
    const required = Array.from({ length: 32 }, (_, index) => `R_${index}`);
    const optional = Array.from({ length: 32 }, (_, index) => `O_${index}`);

    const manifest = accepted(base({ env: { required, optional } }));

    expect(manifest.env.required).toHaveLength(32);
    expect(manifest.env.optional).toHaveLength(32);
  });

  it("rejects one name over the maximum", () => {
    const required = Array.from({ length: 33 }, (_, index) => `R_${index}`);
    const optional = Array.from({ length: 32 }, (_, index) => `O_${index}`);

    expect(onlyIssue(base({ env: { required, optional } }))).toEqual({
      pointer: "/env",
      reason: "ENVIRONMENT_NAMES_EXCEEDED",
    });
  });
});

describe("parseDeployManifest image", () => {
  it.each([[1], [3000], [65_535]])("accepts the port %i", (port) => {
    expect(accepted(base({ image: { port } })).image.port).toBe(port);
  });

  it.each([
    [{ port: 0 }, "PORT_OUT_OF_RANGE"],
    [{ port: -1 }, "PORT_OUT_OF_RANGE"],
    [{ port: 65_536 }, "PORT_OUT_OF_RANGE"],
    [{ port: 3000.5 }, "INTEGER_REQUIRED"],
    [{ port: "3000" }, "INTEGER_REQUIRED"],
    [{ port: null }, "INTEGER_REQUIRED"],
  ])("rejects the port in %j with %s", (image, reason) => {
    expect(onlyIssue(base({ image }))).toEqual({
      pointer: "/image/port",
      reason,
    });
  });

  it.each([
    [{ baseImage: 1 }, "STRING_REQUIRED"],
    [{ baseImage: "" }, "STRING_EMPTY"],
    [{ baseImage: "node:22 slim" }, "STRING_HAS_WHITESPACE"],
    [{ baseImage: "node:22\tslim" }, "STRING_HAS_WHITESPACE"],
    [{ baseImage: "node:22\nslim" }, "STRING_HAS_WHITESPACE"],
    [{ baseImage: "node:22\u0000" }, "STRING_HAS_NUL"],
    [{ baseImage: repeat("\u{1f600}", 1_025) }, "STRING_TOO_LONG"],
  ])("rejects the base image in %# with %s", (image, reason) => {
    expect(onlyIssue(base({ image }))).toEqual({
      pointer: "/image/baseImage",
      reason,
    });
  });

  it("counts Unicode scalar values rather than code units", () => {
    const baseImage = repeat("\u{1f600}", 1_024);

    expect(baseImage.length).toBe(2_048);
    expect(accepted(base({ image: { baseImage } })).image.baseImage).toBe(
      baseImage,
    );
  });
});

describe("parseDeployManifest healthcheck", () => {
  it.each([["alive"], ["ready"]])("accepts the expectation %j", (value) => {
    expect(
      accepted(base({ healthcheck: { expect: value } })).healthcheck.expect,
    ).toBe(value);
  });

  it.each([
    [{ expect: "Alive" }, "/healthcheck/expect", "EXPECTATION_UNSUPPORTED"],
    [{ expect: "" }, "/healthcheck/expect", "EXPECTATION_UNSUPPORTED"],
    [{ expect: 1 }, "/healthcheck/expect", "STRING_REQUIRED"],
    [
      { bearerEnv: "A_TOKEN" },
      "/healthcheck/bearerEnv",
      "BEARER_ENV_NOT_ALLOWED",
    ],
    [
      { expect: "alive", bearerEnv: "A_TOKEN" },
      "/healthcheck/bearerEnv",
      "BEARER_ENV_NOT_ALLOWED",
    ],
    [
      { expect: "ready", bearerEnv: "a-token" },
      "/healthcheck/bearerEnv",
      "ENVIRONMENT_NAME_INVALID",
    ],
    [
      { expect: "ready", bearerEnv: 1 },
      "/healthcheck/bearerEnv",
      "STRING_REQUIRED",
    ],
  ])("rejects %# at %s with %s", (healthcheck, pointer, reason) => {
    expect(onlyIssue(base({ healthcheck }))).toEqual({ pointer, reason });
  });

  it("allows a bearer variable only for a readiness expectation", () => {
    const manifest = accepted(
      base({ healthcheck: { expect: "ready", bearerEnv: "PROBE_TOKEN" } }),
    );

    expect(manifest.healthcheck.bearerEnv).toBe("PROBE_TOKEN");
  });
});

describe("parseDeployManifest diagnostics", () => {
  it("reports every detectable issue in deterministic pointer order", () => {
    const document = base({
      entry: "dist/a.ts",
      env: { required: ["a"], optional: ["A_TOKEN", "A_TOKEN"] },
      image: { baseImage: "", port: 0 },
      healthcheck: { bearerEnv: "B_TOKEN" },
      unknown: true,
    });

    expect(rejected(document)).toEqual([
      { pointer: "/entry", reason: "ENTRY_EXTENSION_UNSUPPORTED" },
      { pointer: "/env/optional/1", reason: "ENVIRONMENT_NAME_DUPLICATE" },
      { pointer: "/env/required/0", reason: "ENVIRONMENT_NAME_INVALID" },
      { pointer: "/healthcheck/bearerEnv", reason: "BEARER_ENV_NOT_ALLOWED" },
      { pointer: "/image/baseImage", reason: "STRING_EMPTY" },
      { pointer: "/image/port", reason: "PORT_OUT_OF_RANGE" },
      { pointer: "/unknown", reason: "UNKNOWN_KEY" },
    ]);
  });

  it("returns an identical issue list across repeated runs", () => {
    const text = JSON.stringify(
      base({ entry: "", image: { port: 0 }, unknown: true, other: true }),
    );

    expect(parseDeployManifest(text)).toEqual(parseDeployManifest(text));
  });

  it("declares a message for every reason it can report", () => {
    const reasons = new Set<DeployManifestIssueReason>();
    for (const document of [
      base({ entry: "dist/a.ts", unknown: true }),
      base({ env: { required: ["a", "a"] } }),
    ]) {
      for (const issue of rejected(document)) reasons.add(issue.reason);
    }

    for (const reason of reasons) {
      expect(deployManifestIssueMessages[reason]).toMatch(/^\S.*\.$/u);
    }
  });

  it("never echoes a rejected value", () => {
    const documents = [
      base({ entry: `dist/${secret}.ts` }),
      base({ entry: secret }),
      base({ env: { required: [secret] } }),
      base({ image: { baseImage: `${secret} ${secret}` } }),
      base({ healthcheck: { expect: secret } }),
      base({ unknown: secret }),
    ];

    for (const document of documents) {
      const issues = rejected(document);
      expect(JSON.stringify(issues)).not.toContain(secret);
      expect(
        JSON.stringify(
          issues.map((issue) => deployManifestIssueMessages[issue.reason]),
        ),
      ).not.toContain(secret);
    }
  });
});

describe("loadDeployManifest", () => {
  it("reads the manifest beside the project root", async () => {
    const readFile = vi.fn(async () => JSON.stringify(base()));

    const result = await loadDeployManifest({
      cwd: "/workspace/engine",
      readFile,
    });

    expect(result.ok).toBe(true);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(
      join("/workspace/engine", deployManifestFileName),
    );
  });

  it.each([["ENOENT"], ["ENOTDIR"]])(
    "maps the %s read failure to MANIFEST_NOT_FOUND",
    async (code) => {
      const readFile = vi.fn(async () => {
        throw Object.assign(new Error(secret), { code });
      });

      const result = await loadDeployManifest({ cwd: "/engine", readFile });

      expect(result).toEqual({
        ok: false,
        code: "MANIFEST_NOT_FOUND",
        issues: [],
      });
    },
  );

  it.each([["EACCES"], ["EISDIR"], [undefined]])(
    "maps the %s read failure to an unreadable document",
    async (code) => {
      const readFile = vi.fn(async () => {
        throw Object.assign(new Error(secret), { code });
      });

      const result = await loadDeployManifest({ cwd: "/engine", readFile });

      expect(result).toEqual({
        ok: false,
        code: "MANIFEST_INVALID",
        issues: [{ pointer: "", reason: "DOCUMENT_UNREADABLE" }],
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  it("reports manifest issues from the loaded document", async () => {
    const readFile = vi.fn(async () => JSON.stringify(base({ entry: "a.ts" })));

    const result = await loadDeployManifest({ cwd: "/engine", readFile });

    expect(result).toEqual({
      ok: false,
      code: "MANIFEST_INVALID",
      issues: [{ pointer: "/entry", reason: "ENTRY_EXTENSION_UNSUPPORTED" }],
    });
  });
});

describe("toDeployError", () => {
  it("renders one detail line per issue, quoting the pointer", () => {
    const result = parse(base({ entry: "a.ts", unknown: true }));
    if (result.ok) throw new Error("expected the manifest to be rejected");

    const error = toDeployError(result);

    expect(error.code).toBe("MANIFEST_INVALID");
    expect(error.exitCode).toBe(2);
    expect(error.details).toEqual([
      `"/entry": ${deployManifestIssueMessages.ENTRY_EXTENSION_UNSUPPORTED}`,
      `"/unknown": ${deployManifestIssueMessages.UNKNOWN_KEY}`,
    ]);
  });

  it("carries no detail for a missing manifest", () => {
    const error = toDeployError({
      ok: false,
      code: "MANIFEST_NOT_FOUND",
      issues: [],
    });

    expect(error.code).toBe("MANIFEST_NOT_FOUND");
    expect(error.exitCode).toBe(2);
    expect(error.details).toEqual([]);
  });

  it("quotes a pointer so a crafted key cannot forge a diagnostic line", () => {
    const result = parse(base({ "a\nb": true }));
    if (result.ok) throw new Error("expected the manifest to be rejected");

    const error = toDeployError(result);

    expect(error.details).toEqual([
      `"/a\\nb": ${deployManifestIssueMessages.UNKNOWN_KEY}`,
    ]);
    expect(error.details[0]).not.toContain("\n");
  });
});
