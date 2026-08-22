import { describe, expect, it, vi } from "vitest";

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

function samplerOperation(
  name: string,
  schema: Readonly<Record<string, unknown>>,
): OpenApiStarterOperation {
  return Object.freeze({
    ...selectedOperations[0],
    operationId: name,
    capabilityId: `openapi.${name}`,
    exportName: name.replace(/-([a-z])/gu, (_, letter: string) =>
      letter.toUpperCase(),
    ),
    moduleName: name,
    selector: `GET:/${name}`,
    path: `/${name}`,
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ value: schema }),
      required: Object.freeze(["value"]),
      additionalProperties: false,
    }),
    outputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ status: Object.freeze({ const: 204 }) }),
      required: Object.freeze(["status"]),
      additionalProperties: false,
    }),
  });
}

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

describe("createOpenApiStarterFiles", () => {
  it("never constructs or executes document-controlled witness patterns", () => {
    const pattern = "^(x+)+y$";
    const operation = samplerOperation("hostile-pattern", {
      type: "string",
      pattern,
    });
    const originalRegExp = globalThis.RegExp;
    const regexpConstructor = vi
      .spyOn(globalThis, "RegExp")
      .mockImplementation(function guardedRegExp(
        source?: string | RegExp,
        flags?: string,
      ) {
        if (source === pattern) {
          throw new Error("document-controlled RegExp construction attempted");
        }
        return Reflect.construct(originalRegExp, [source, flags]) as RegExp;
      } as RegExpConstructor);

    try {
      const contents = fileContents(
        createOpenApiStarterFiles({
          projectName: "pattern-engine",
          invoktaVersion: "1.2.3",
          packageManager: "npm",
          profile: "cli",
          selectedOperations: Object.freeze([operation]),
        }),
      );
      const generatedTest = contents.get("test/engine.test.ts") ?? "";

      expect(occurrences(generatedTest, '"openapi.hostile-pattern"')).toBe(1);
      expect(generatedTest.length).toBeLessThan(8_192);
      expect(
        regexpConstructor.mock.calls.some(([source]) => source === pattern),
      ).toBe(false);
    } finally {
      regexpConstructor.mockRestore();
    }
  });

  it("bounds nested sampler allocations and generated witness source", () => {
    const operations = Object.freeze([
      samplerOperation("within-string-budget", {
        type: "string",
        minLength: 4_000,
      }),
      samplerOperation("over-string-budget", {
        type: "string",
        minLength: 4_097,
      }),
      samplerOperation("edge-string-budget", {
        type: "string",
        minLength: 4_096,
      }),
      samplerOperation("within-array-budget", {
        type: "array",
        minItems: 2_000,
        items: true,
      }),
      samplerOperation("over-array-budget", {
        type: "array",
        minItems: 4_097,
        items: true,
      }),
      samplerOperation("edge-array-budget", {
        type: "array",
        minItems: 4_096,
        items: true,
      }),
      samplerOperation("huge-array-budget", {
        type: "array",
        minItems: Number.MAX_SAFE_INTEGER,
        items: true,
      }),
      samplerOperation("huge-string-budget", {
        type: "string",
        minLength: Number.MAX_SAFE_INTEGER,
      }),
    ]);
    const originalRepeat = String.prototype.repeat;
    const originalArrayFrom = Array.from;
    const repeat = vi
      .spyOn(String.prototype, "repeat")
      .mockImplementation(function guardedRepeat(this: string, count) {
        if (count > 4_096) throw new Error("oversized repeat attempted");
        return originalRepeat.call(this, count);
      });
    const arrayFrom = vi.spyOn(Array, "from").mockImplementation(((
      items: unknown,
      ...rest: unknown[]
    ) => {
      const length =
        typeof items === "object" &&
        items !== null &&
        "length" in items &&
        typeof items.length === "number"
          ? items.length
          : undefined;
      if (length !== undefined && length > 4_096) {
        throw new Error("oversized Array.from attempted");
      }
      return Reflect.apply(originalArrayFrom, Array, [items, ...rest]);
    }) as typeof Array.from);

    try {
      const contents = fileContents(
        createOpenApiStarterFiles({
          projectName: "sampler-engine",
          invoktaVersion: "1.2.3",
          packageManager: "npm",
          profile: "cli",
          selectedOperations: operations,
        }),
      );
      const generatedTest = contents.get("test/engine.test.ts") ?? "";

      expect(occurrences(generatedTest, '"openapi.within-string-budget"')).toBe(
        2,
      );
      expect(occurrences(generatedTest, '"openapi.over-string-budget"')).toBe(
        1,
      );
      expect(occurrences(generatedTest, '"openapi.edge-string-budget"')).toBe(
        1,
      );
      expect(occurrences(generatedTest, '"openapi.within-array-budget"')).toBe(
        2,
      );
      expect(occurrences(generatedTest, '"openapi.over-array-budget"')).toBe(1);
      expect(occurrences(generatedTest, '"openapi.edge-array-budget"')).toBe(1);
      expect(occurrences(generatedTest, '"openapi.huge-array-budget"')).toBe(1);
      expect(occurrences(generatedTest, '"openapi.huge-string-budget"')).toBe(
        1,
      );
      expect(generatedTest.length).toBeLessThan(40_000);
      expect(repeat.mock.calls.some(([count]) => count >= 4_096)).toBe(false);
      expect(
        arrayFrom.mock.calls.some(([items]) => {
          return (
            typeof items === "object" &&
            items !== null &&
            "length" in items &&
            typeof items.length === "number" &&
            items.length >= 4_096
          );
        }),
      ).toBe(false);
    } finally {
      repeat.mockRestore();
      arrayFrom.mockRestore();
    }
  });

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
    const openApiEngineSource = contents.get("src/openapi-engine.ts") ?? "";
    const allGeneratedSource = [...contents.values()].join("\n");
    const expectedCapabilityIds = selectedOperations.map(
      (operation) => operation.capabilityId,
    );

    expect(capabilityEntries).toHaveLength(selectedOperations.length);
    for (const capabilityId of expectedCapabilityIds) {
      expect(openApiEngineSource).toContain(JSON.stringify(capabilityId));
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

  it("generates narrow operation ports and one typed outbound connector", () => {
    const contents = fileContents(createFiles());
    const capabilitySource = [...contents]
      .filter(([path]) => path.startsWith("src/capabilities/"))
      .map(([, source]) => source)
      .join("\n");
    const portSource = contents.get("src/openapi/ports.ts") ?? "";
    const connectorSource = contents.get("src/openapi/connector.ts") ?? "";
    const engineSource = contents.get("src/engine.ts") ?? "";
    const openApiEngineSource = contents.get("src/openapi-engine.ts") ?? "";

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
    expect(capabilitySource).toContain("port.invoke(input");
    expect(capabilitySource).not.toContain("OpenApiOperationPlan");
    expect(capabilitySource).not.toContain("const operation =");
    expect(capabilitySource).not.toContain("serverUrls");
    expect(capabilitySource).not.toContain("security:");
    expect(portSource).toContain("export interface OpenApiPorts");
    expect(portSource).toContain("export type RootServerPort");
    expect(portSource).toContain("export type GetWithoutOperationIdPort");
    expect(portSource).toContain("readonly signal: AbortSignal");
    expect(connectorSource).toContain("defineConnector({");
    expect(connectorSource).toContain('name: "generated-openapi-fetch"');
    expect(connectorSource).toContain("config: openApiConnectorConfig");
    expect(connectorSource).toContain("dependencies.fetch");
    expect(connectorSource).toContain("rootServer:");
    expect(connectorSource).toContain("getWithoutOperationId:");
    expect(connectorSource).toContain("signal: options.signal");
    expect(connectorSource).toContain('redirect: "manual"');
    expect(connectorSource).toContain("10 * 1024 * 1024");
    expect(connectorSource).toContain("encoder.encode(url.href).byteLength");
    expect(connectorSource).toContain(
      "contentType.toLowerCase() !== expected.mediaType.toLowerCase()",
    );
    expect(connectorSource).toContain("outputValidator.safeParse(output)");
    expect(connectorSource).toContain(
      "if (partiallyConfigured) throw configurationFailure()",
    );
    expect(connectorSource).toContain("The upstream API request failed.");
    expect(connectorSource).not.toContain("responseBody");
    expect(connectorSource).not.toContain("authorizationValue");
    expect(engineSource).toContain("fetchOpenApiConnector.create(");
    expect(engineSource).toContain("ports: connector.ports");
    expect(engineSource).not.toContain("OpenApiUpstream");
    expect(openApiEngineSource).toContain(
      "export function createOpenApiEngine({ ports }",
    );
    expect(openApiEngineSource).not.toContain("fetchOpenApiConnector");
    expect(contents.has("src/openapi/upstream.ts")).toBe(false);
    expect(contents.has("src/openapi/fetch-adapter.ts")).toBe(false);
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
