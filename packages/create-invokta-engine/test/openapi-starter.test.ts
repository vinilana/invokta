import { describe, expect, it } from "vitest";

import {
  createOpenApiStarterFiles,
  type OpenApiStarterOperation,
} from "../src/openapi-starter.js";
import type { EngineStarterProfile, StarterEntry } from "../src/starter.js";

const objectSchema = Object.freeze({
  type: "object",
  properties: {},
  additionalProperties: false,
} as const);

const selectedOperations = Object.freeze([
  Object.freeze({
    selector: "GET:/root-server",
    operationId: "rootServer",
    capabilityId: "openapi.root-server",
    exportName: "rootServer",
    moduleName: "root-server",
    method: "GET",
    path: "/root-server",
    title: "Root server",
    description: "Uses the root OpenAPI server.",
    connection: Object.freeze({
      serverSource: "root",
      serverUrls: Object.freeze(["https://root.example.test/v1"]),
      baseUrl: Object.freeze({
        environmentVariable: "OPENAPI_ROOT_SERVER_BASE_URL",
        default: "https://root.example.test/v1",
      }),
    }),
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    parameters: Object.freeze([]),
    requestBody: undefined,
    successResponses: Object.freeze([
      Object.freeze({ status: "204", mediaType: undefined, schema: undefined }),
    ]),
    security: Object.freeze({
      alternatives: Object.freeze([Object.freeze([])]),
    }),
  }),
  Object.freeze({
    selector: "GET:/without-operation-id",
    capabilityId: "openapi.get-without-operation-id",
    exportName: "getWithoutOperationId",
    moduleName: "get-without-operation-id",
    method: "GET",
    path: "/without-operation-id",
    title: "GET /without-operation-id",
    description: "Uses a canonical selector when operationId is absent.",
    connection: Object.freeze({
      serverSource: "root",
      serverUrls: Object.freeze(["https://root.example.test/v1"]),
      baseUrl: Object.freeze({
        environmentVariable: "OPENAPI_GET_WITHOUT_OPERATION_ID_BASE_URL",
        default: "https://root.example.test/v1",
      }),
    }),
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    parameters: Object.freeze([]),
    requestBody: undefined,
    successResponses: Object.freeze([
      Object.freeze({ status: "204", mediaType: undefined, schema: undefined }),
    ]),
    security: Object.freeze({
      alternatives: Object.freeze([Object.freeze([])]),
    }),
  }),
] as const satisfies readonly OpenApiStarterOperation[]);

function fileContents(entries: readonly StarterEntry[]): Map<string, string> {
  return new Map(
    entries.flatMap((entry) =>
      entry.kind === "file" ? [[entry.path, entry.contents] as const] : [],
    ),
  );
}

function createFiles(
  profile: EngineStarterProfile = "complete",
): readonly StarterEntry[] {
  return createOpenApiStarterFiles({
    projectName: "discovery-engine",
    invoktaVersion: "1.2.3",
    packageManager: "npm",
    profile,
    selectedOperations,
  });
}

describe("createOpenApiStarterFiles", () => {
  it("rejects duplicate final module basenames before files can be overwritten", () => {
    const first = selectedOperations[0];
    const duplicate = Object.freeze({
      ...selectedOperations[1],
      moduleName: first.moduleName,
    });

    expect(() =>
      createOpenApiStarterFiles({
        projectName: "collision-engine",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
        profile: "cli",
        selectedOperations: Object.freeze([first, duplicate]),
      }),
    ).toThrowError(/duplicate portable module name/u);
  });

  it("generates capability modules and engine registrations only for selected operations", () => {
    const entries = createFiles();
    const contents = fileContents(entries);
    const capabilityEntries = entries.filter(
      (entry) =>
        entry.kind === "file" && entry.path.startsWith("src/capabilities/"),
    );
    const engineSource = contents.get("src/engine.ts") ?? "";
    const allGeneratedSource = [...contents.values()].join("\n");
    const expectedCapabilityIds = selectedOperations.map(
      (operation) => operation.capabilityId,
    );

    expect(capabilityEntries).toHaveLength(selectedOperations.length);
    for (const capabilityId of expectedCapabilityIds) {
      expect(engineSource).toContain(JSON.stringify(capabilityId));
    }
    for (const omitted of ["sharedAlias", "operationServer", "pathServer"]) {
      expect(allGeneratedSource).not.toContain(omitted);
    }
    expect(entries.map((entry) => entry.path)).not.toContain(
      "src/capabilities/create-welcome-message.ts",
    );
    expect(allGeneratedSource).not.toContain(
      "onboarding.create-welcome-message",
    );
  });

  it("returns deterministic immutable entries in lexicographic path order", () => {
    const first = createFiles();
    const second = createFiles();

    expect(first).toEqual(second);
    expect(first.map((entry) => entry.path)).toEqual(
      first.map((entry) => entry.path).toSorted(),
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.every((entry) => Object.isFrozen(entry))).toBe(true);
    for (const entry of first) {
      if (entry.kind !== "file") continue;
      expect(entry.contents).not.toContain("\r");
      expect(entry.contents.endsWith("\n")).toBe(true);
      expect(entry.contents.endsWith("\n\n")).toBe(false);
    }
  });

  it("emits names-only inferred connection configuration and forwards the same names", () => {
    const contents = fileContents(createFiles());
    const environmentTemplate = contents.get("upstream.env.example") ?? "";
    const manifest = JSON.parse(contents.get("invokta.mcp.json") ?? "") as {
      readonly capabilityIds: readonly string[];
      readonly server: { readonly forwardEnv: readonly string[] };
    };
    const expectedCapabilityIds = selectedOperations.map(
      (operation) => operation.capabilityId,
    );

    expect(manifest.capabilityIds).toEqual(expectedCapabilityIds);
    expect(manifest.server.forwardEnv.length).toBeGreaterThan(0);
    expect(manifest.server.forwardEnv).toEqual(
      [...manifest.server.forwardEnv].sort(),
    );
    for (const name of manifest.server.forwardEnv) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/u);
      expect(environmentTemplate).toContain(`${name}=\n`);
    }
    expect(environmentTemplate).not.toContain("root.example.test");
    expect(environmentTemplate).not.toContain("path.example.test");
    expect(environmentTemplate).not.toContain("operation.example.test");
  });

  it.each([
    [
      "complete",
      ["src/direct.ts", "src/cli.ts", "src/mcp-stdio.ts", "src/mcp-http.ts"],
    ],
    ["mcp-stdio", ["src/direct.ts", "src/mcp-stdio.ts"]],
    ["mcp-http", ["src/direct.ts", "src/mcp-http.ts"]],
    ["cli", ["src/direct.ts", "src/cli.ts"]],
  ] as const)(
    "shares one engine across the %s profile adapters",
    (profile, paths) => {
      const contents = fileContents(createFiles(profile));

      for (const path of paths) {
        expect(contents.get(path)).toContain(
          'import { engine } from "./engine.js";',
        );
      }
    },
  );

  it("generates object schemas and the cancellation, timeout, and sanitized failure boundaries", () => {
    const contents = fileContents(createFiles());
    const capabilitySource = [...contents]
      .filter(([path]) => path.startsWith("src/capabilities/"))
      .map(([, source]) => source)
      .join("\n");
    const portSource = contents.get("src/openapi/upstream.ts") ?? "";
    const adapterSource = contents.get("src/openapi/fetch-adapter.ts") ?? "";

    expect(capabilitySource).toContain("const inputSchema = schemaContract(");
    expect(capabilitySource).toContain("const outputSchema = schemaContract(");
    expect(capabilitySource).toContain(
      'validator["~standard"].validate(value)',
    );
    expect(capabilitySource).toContain("input: () => schema");
    expect(capabilitySource).toContain("output: () => schema");
    expect(capabilitySource).toContain("input: inputSchema");
    expect(capabilitySource).toContain("output: outputSchema");
    expect(capabilitySource).toContain("timeoutMs: 30_000");
    expect(capabilitySource).toContain("signal: context.signal");
    expect(portSource).toContain("readonly signal: AbortSignal");
    expect(adapterSource).toContain("signal: request.signal");
    expect(adapterSource).toContain('redirect: "manual"');
    expect(adapterSource).toContain("10 * 1024 * 1024");
    expect(adapterSource).toContain("encoder.encode(url.href).byteLength");
    expect(adapterSource).toContain(
      "contentType.toLowerCase() !== expected.mediaType.toLowerCase()",
    );
    expect(adapterSource).toContain("if (partiallyConfigured) throw failure()");
    expect(adapterSource).toContain("The upstream API request failed.");
    expect(adapterSource).not.toContain("responseBody");
    expect(adapterSource).not.toContain("authorizationValue");
  });

  it("requires domain and access review in every author-facing instruction", () => {
    const contents = fileContents(createFiles());
    const instruction =
      "Review every generated capability's domain meaning and access rule before deployment.";

    for (const path of [
      "README.md",
      "AGENTS.md",
      ".agents/skills/develop-invokta-project/SKILL.md",
    ]) {
      expect(contents.get(path)).toContain(instruction);
    }
  });
});
