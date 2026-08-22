import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createOpenApiStarterFiles,
  type OpenApiStarterOperation,
} from "../src/openapi-starter.js";
import type { StarterEntry } from "../src/starter.js";

const repositoryRoot = new URL("../../../", import.meta.url);
const compilerPath = join(
  repositoryRoot.pathname,
  "node_modules/typescript/bin/tsc",
);
const vitestPath = join(
  repositoryRoot.pathname,
  "node_modules/vitest/vitest.mjs",
);
const nodeModulesPath = join(repositoryRoot.pathname, "node_modules");
const capabilityId = "widgets.create-widget";
const credential = "generated-runtime-secret";
const leakedBody = "upstream-private-response";
const validConnectorConfig = Object.freeze({
  OPENAPI_REQUIRED_TOKEN: credential,
  OPENAPI_SERVICE_TOKEN: credential,
});

const widgetSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    id: Object.freeze({ type: "string" }),
    name: Object.freeze({ type: "string" }),
  }),
  required: Object.freeze(["id", "name"]),
  additionalProperties: false,
});

const createWidgetOperation = Object.freeze({
  selector: "POST:/widgets/{widgetId}",
  operationId: "createWidget",
  capabilityId,
  exportName: "createWidget",
  moduleName: "create-widget",
  method: "POST",
  path: "/widgets/{widgetId}",
  title: "Create widget",
  description: "Creates one widget through the inferred upstream connection.",
  connection: Object.freeze({
    serverSource: "root",
    serverUrls: Object.freeze(["https://api.example.test/v1"]),
    baseUrl: Object.freeze({
      environmentVariable: "OPENAPI_CREATE_WIDGET_BASE_URL",
      default: "https://api.example.test/v1",
    }),
  }),
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      path: Object.freeze({
        type: "object",
        properties: Object.freeze({
          widgetId: Object.freeze({
            anyOf: Object.freeze([
              Object.freeze({ type: "string" }),
              Object.freeze({
                type: "array",
                items: Object.freeze({ type: "string" }),
              }),
            ]),
          }),
        }),
        required: Object.freeze(["widgetId"]),
        additionalProperties: false,
      }),
      query: Object.freeze({
        type: "object",
        properties: Object.freeze({
          tags: Object.freeze({
            type: "array",
            items: Object.freeze({ type: "string" }),
          }),
          visible: Object.freeze({ type: "boolean" }),
        }),
        additionalProperties: false,
      }),
      headers: Object.freeze({
        type: "object",
        properties: Object.freeze({
          "X-Correlation-Id": Object.freeze({ type: "string" }),
        }),
        additionalProperties: false,
      }),
      cookies: Object.freeze({
        type: "object",
        properties: Object.freeze({
          expanded: Object.freeze({
            type: "array",
            items: Object.freeze({ type: "string" }),
          }),
          compact: Object.freeze({
            type: "array",
            items: Object.freeze({ type: "string" }),
          }),
        }),
        additionalProperties: false,
      }),
      body: widgetSchema,
    }),
    required: Object.freeze(["path", "body"]),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: "object",
    oneOf: Object.freeze([
      Object.freeze({
        type: "object",
        properties: Object.freeze({
          status: Object.freeze({ const: 201 }),
          body: widgetSchema,
        }),
        required: Object.freeze(["status", "body"]),
        additionalProperties: false,
      }),
      Object.freeze({
        type: "object",
        properties: Object.freeze({
          status: Object.freeze({ const: 204 }),
        }),
        required: Object.freeze(["status"]),
        additionalProperties: false,
      }),
    ]),
  }),
  parameters: Object.freeze([
    Object.freeze({
      name: "widgetId",
      in: "path",
      required: true,
      style: "simple",
      explode: false,
      schema: Object.freeze({
        anyOf: Object.freeze([
          Object.freeze({ type: "string" }),
          Object.freeze({
            type: "array",
            items: Object.freeze({ type: "string" }),
          }),
        ]),
      }),
    }),
    Object.freeze({
      name: "tags",
      in: "query",
      required: false,
      style: "form",
      explode: true,
      schema: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
      }),
    }),
    Object.freeze({
      name: "visible",
      in: "query",
      required: false,
      style: "form",
      explode: true,
      schema: Object.freeze({ type: "boolean" }),
    }),
    Object.freeze({
      name: "X-Correlation-Id",
      in: "header",
      required: false,
      style: "simple",
      explode: false,
      schema: Object.freeze({ type: "string" }),
    }),
    Object.freeze({
      name: "expanded",
      in: "cookie",
      required: false,
      style: "form",
      explode: true,
      schema: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
      }),
    }),
    Object.freeze({
      name: "compact",
      in: "cookie",
      required: false,
      style: "form",
      explode: false,
      schema: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
      }),
    }),
  ]),
  requestBody: Object.freeze({
    required: true,
    mediaType: "application/json",
    schema: widgetSchema,
  }),
  successResponses: Object.freeze([
    Object.freeze({
      status: "201",
      mediaType: "application/json",
      schema: widgetSchema,
    }),
    Object.freeze({
      status: "204",
      mediaType: undefined,
      schema: undefined,
    }),
  ]),
  security: Object.freeze({
    alternatives: Object.freeze([
      Object.freeze([
        Object.freeze({
          name: "serviceToken",
          type: "apiKey",
          in: "header",
          parameterName: "X-Service-Token",
          environmentVariables: Object.freeze({
            value: "OPENAPI_SERVICE_TOKEN",
          }),
        }),
      ]),
      Object.freeze([
        Object.freeze({
          name: "basicService",
          type: "basic",
          environmentVariables: Object.freeze({
            username: "OPENAPI_BASIC_USERNAME",
            password: "OPENAPI_BASIC_PASSWORD",
          }),
        }),
      ]),
      Object.freeze([]),
    ]),
  }),
} as const satisfies OpenApiStarterOperation);

function stringQueryOperation(options: {
  readonly capabilityId: string;
  readonly exportName: string;
  readonly moduleName: string;
  readonly path: string;
  readonly schema: Readonly<Record<string, unknown>>;
}): OpenApiStarterOperation {
  const inputSchema = Object.freeze({
    type: "object",
    properties: Object.freeze({
      query: Object.freeze({
        type: "object",
        properties: Object.freeze({ value: options.schema }),
        required: Object.freeze(["value"]),
        additionalProperties: false,
      }),
    }),
    required: Object.freeze(["query"]),
    additionalProperties: false,
  });
  return Object.freeze({
    selector: `GET:${options.path}`,
    capabilityId: options.capabilityId,
    exportName: options.exportName,
    moduleName: options.moduleName,
    method: "GET",
    path: options.path,
    title: options.capabilityId,
    description: `Exercises ${options.capabilityId}.`,
    connection: Object.freeze({
      serverSource: "root",
      serverUrls: Object.freeze(["https://api.example.test/v1"]),
      baseUrl: Object.freeze({
        environmentVariable: `OPENAPI_${options.exportName.toUpperCase()}_BASE_URL`,
        default: "https://api.example.test/v1",
      }),
    }),
    inputSchema,
    outputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ status: Object.freeze({ const: 204 }) }),
      required: Object.freeze(["status"]),
      additionalProperties: false,
    }),
    parameters: Object.freeze([
      Object.freeze({
        name: "value",
        in: "query",
        required: true,
        style: "form",
        explode: true,
        schema: options.schema,
      }),
    ]),
    requestBody: undefined,
    successResponses: Object.freeze([
      Object.freeze({ status: "204", mediaType: undefined, schema: undefined }),
    ]),
    security: Object.freeze({
      alternatives: Object.freeze([Object.freeze([])]),
    }),
  });
}

const emptyStringOperation = stringQueryOperation({
  capabilityId: "widgets.empty-string",
  exportName: "emptyString",
  moduleName: "empty-string",
  path: "/empty-string",
  schema: Object.freeze({ type: "string", maxLength: 0 }),
});

const patternFallbackOperation = stringQueryOperation({
  capabilityId: "widgets.pattern-fallback",
  exportName: "patternFallback",
  moduleName: "pattern-fallback",
  path: "/pattern-fallback",
  schema: Object.freeze({ type: "string", pattern: "^(x+)+y$" }),
});

const defaultedResponseSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    label: Object.freeze({ type: "string", default: "generated" }),
  }),
  additionalProperties: false,
});

const defaultedResponseOperation = Object.freeze({
  selector: "GET:/defaulted-response",
  capabilityId: "widgets.defaulted-response",
  exportName: "defaultedResponse",
  moduleName: "defaulted-response",
  method: "GET",
  path: "/defaulted-response",
  title: "Defaulted response",
  description: "Exercises output validation that transforms the fake response.",
  connection: Object.freeze({
    serverSource: "root",
    serverUrls: Object.freeze(["https://api.example.test/v1"]),
    baseUrl: Object.freeze({
      environmentVariable: "OPENAPI_DEFAULTED_RESPONSE_BASE_URL",
      default: "https://api.example.test/v1",
    }),
  }),
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      status: Object.freeze({ const: 200 }),
      body: defaultedResponseSchema,
    }),
    required: Object.freeze(["status", "body"]),
    additionalProperties: false,
  }),
  parameters: Object.freeze([]),
  requestBody: undefined,
  successResponses: Object.freeze([
    Object.freeze({
      status: "200",
      mediaType: "application/json",
      schema: defaultedResponseSchema,
    }),
  ]),
  security: Object.freeze({ alternatives: Object.freeze([Object.freeze([])]) }),
} as const satisfies OpenApiStarterOperation);

function widgetOperationVariant(
  capability: string,
  exportName: string,
  moduleName: string,
  path: string,
): OpenApiStarterOperation {
  return Object.freeze({
    ...createWidgetOperation,
    selector: `POST:${path}`,
    operationId: exportName,
    capabilityId: capability,
    exportName,
    moduleName,
    path,
  });
}

const authorityPathOperations = Object.freeze([
  widgetOperationVariant(
    "widgets.authority-slashes",
    "authoritySlashes",
    "authority-slashes",
    "///collector.example/steal",
  ),
  widgetOperationVariant(
    "widgets.authority-backslash",
    "authorityBackslash",
    "authority-backslash",
    "/\\collector.example/steal",
  ),
  widgetOperationVariant(
    "widgets.authority-absolute",
    "authorityAbsolute",
    "authority-absolute",
    "https://collector.example/steal",
  ),
]);

const repeatedPathOperation = widgetOperationVariant(
  "widgets.repeated-path",
  "repeatedPath",
  "repeated-path",
  "/widgets/{widgetId}/related/{widgetId}",
);

const requiredAuthOperation = Object.freeze({
  ...widgetOperationVariant(
    "widgets.required-auth",
    "requiredAuth",
    "required-auth",
    "/required-auth/{widgetId}",
  ),
  security: Object.freeze({
    alternatives: Object.freeze([
      Object.freeze([
        Object.freeze({
          name: "requiredToken",
          type: "apiKey",
          in: "header",
          parameterName: "X-Required-Token",
          environmentVariables: Object.freeze({
            value: "OPENAPI_REQUIRED_TOKEN",
          }),
        }),
      ]),
    ]),
  }),
} as const satisfies OpenApiStarterOperation);

interface GeneratedPort {
  readonly invoke: (
    input: Readonly<Record<string, unknown>>,
    options: Readonly<{ readonly signal: AbortSignal }>,
  ) => Promise<Record<string, unknown>>;
}

type GeneratedPorts = Readonly<Record<string, GeneratedPort>>;

interface GeneratedEngine {
  readonly invoke: (
    selectedCapabilityId: string,
    input: unknown,
    options: Readonly<{
      principal: null;
      signal?: AbortSignal;
    }>,
  ) => Promise<unknown>;
  readonly describe: (selectedCapabilityId: string) => Readonly<{
    outputSchema: Readonly<Record<string, unknown>>;
  }>;
  readonly list: () => readonly Readonly<{ readonly id: string }>[];
}

interface GeneratedEngineModule {
  readonly createOpenApiEngine: (options: {
    readonly ports: GeneratedPorts;
  }) => GeneratedEngine;
}

interface GeneratedConnectorModule {
  readonly fetchOpenApiConnector: Readonly<{
    readonly name: string;
    readonly create: (
      config: Readonly<Record<string, string>>,
      dependencies: Readonly<{ readonly fetch: typeof globalThis.fetch }>,
    ) => Readonly<{ readonly ports: GeneratedPorts }>;
  }>;
}

const input = Object.freeze({
  path: Object.freeze({ widgetId: "a/b" }),
  query: Object.freeze({ tags: Object.freeze(["red", "blue"]), visible: true }),
  headers: Object.freeze({ "X-Correlation-Id": "request-123" }),
  body: Object.freeze({ id: "a/b", name: "Ada" }),
});

let projectDirectory: string;
let engineModule: GeneratedEngineModule;
let connectorModule: GeneratedConnectorModule;

function materialize(
  entries: readonly StarterEntry[],
  directory: string,
): void {
  for (const entry of entries) {
    const destination = join(directory, entry.path);
    mkdirSync(dirname(destination), { recursive: true });
    if (entry.kind === "file") {
      writeFileSync(destination, entry.contents, "utf8");
    } else {
      symlinkSync(entry.target, destination);
    }
  }
}

function createRuntime(
  fetchImplementation: typeof globalThis.fetch,
): GeneratedEngine {
  const connector = connectorModule.fetchOpenApiConnector.create(
    validConnectorConfig,
    { fetch: fetchImplementation },
  );
  return engineModule.createOpenApiEngine({ ports: connector.ports });
}

async function capturedFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the generated engine invocation to fail.");
}

function compileGeneratedProject(): void {
  try {
    execFileSync(
      process.execPath,
      [
        compilerPath,
        "-p",
        join(projectDirectory, "tsconfig.json"),
        "--pretty",
        "false",
      ],
      { cwd: projectDirectory, encoding: "utf8", stdio: "pipe" },
    );
  } catch (error) {
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr
        : "";
    const stdout =
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof error.stdout === "string"
        ? error.stdout
        : "";
    throw new Error(
      `Generated OpenAPI project did not compile.\n${stdout}${stderr}`,
      { cause: error },
    );
  }
}

function runGeneratedProjectTests(): void {
  try {
    execFileSync(process.execPath, [vitestPath, "run", "test/engine.test.ts"], {
      cwd: projectDirectory,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const output =
      typeof error === "object" && error !== null
        ? `${"stdout" in error && typeof error.stdout === "string" ? error.stdout : ""}${"stderr" in error && typeof error.stderr === "string" ? error.stderr : ""}`
        : "";
    throw new Error(`Generated OpenAPI tests did not pass.\n${output}`, {
      cause: error,
    });
  }
}

beforeAll(async () => {
  projectDirectory = mkdtempSync(join(tmpdir(), "invokta-openapi-runtime-"));
  materialize(
    createOpenApiStarterFiles({
      projectName: "generated-openapi-runtime",
      invoktaVersion: "1.2.3",
      packageManager: "npm",
      profile: "cli",
      selectedOperations: Object.freeze([
        createWidgetOperation,
        emptyStringOperation,
        patternFallbackOperation,
        defaultedResponseOperation,
        ...authorityPathOperations,
        repeatedPathOperation,
        requiredAuthOperation,
      ]),
    }),
    projectDirectory,
  );
  symlinkSync(nodeModulesPath, join(projectDirectory, "node_modules"), "dir");
  compileGeneratedProject();
  engineModule = (await import(
    pathToFileURL(join(projectDirectory, "dist/openapi-engine.js")).href
  )) as GeneratedEngineModule;
  connectorModule = (await import(
    pathToFileURL(join(projectDirectory, "dist/openapi/connector.js")).href
  )) as GeneratedConnectorModule;
});

afterAll(() => {
  if (projectDirectory !== undefined) {
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

describe("generated OpenAPI runtime", () => {
  it("publishes a literal object root for multiple successful responses", () => {
    const engine = engineModule.createOpenApiEngine({
      ports: {
        createWidget: {
          async invoke() {
            return { status: 204 };
          },
        },
      },
    });

    expect(engine.describe(capabilityId).outputSchema).toMatchObject({
      type: "object",
      oneOf: expect.any(Array),
    });
  });

  it("ships an executable fake-port test derived from the generated operation", () => {
    const generatedTest = readFileSync(
      join(projectDirectory, "test/engine.test.ts"),
      "utf8",
    );
    expect(generatedTest).toContain(
      "validates $selector contract without calling upstream",
    );
    expect(generatedTest).toContain(
      "invokes $selector for declared status $status when a witness is proven",
    );
    expect(
      generatedTest.match(/"capabilityId": "widgets\.empty-string"/gu),
    ).toHaveLength(2);
    expect(
      generatedTest.match(/"capabilityId": "widgets\.pattern-fallback"/gu),
    ).toHaveLength(1);
    expect(
      generatedTest.match(/"capabilityId": "widgets\.defaulted-response"/gu),
    ).toHaveLength(2);
    expect(generatedTest).toContain(
      'expect(Object.hasOwn(result, "body")).toBe(Object.hasOwn(output, "body"));',
    );
    expect(generatedTest).not.toContain("resolves.toEqual(output)");
    expect(runGeneratedProjectTests).not.toThrow();
  });

  it("places the inferred method, parameters, body, and authentication in one request", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async (_input, _init) =>
        new Response(JSON.stringify({ id: "a/b", name: "Created" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const engine = createRuntime(fetchImplementation);

    await expect(
      engine.invoke(capabilityId, input, { principal: null }),
    ).resolves.toEqual({
      status: 201,
      body: { id: "a/b", name: "Created" },
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [requestTarget, requestInit] =
      fetchImplementation.mock.calls[0] ?? [];
    const url = new URL(String(requestTarget));
    const headers = new Headers(requestInit?.headers);
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.redirect).toBe("manual");
    expect(url.origin).toBe("https://api.example.test");
    expect(url.pathname).toBe("/v1/widgets/a%2Fb");
    expect(url.searchParams.getAll("tags")).toEqual(["red", "blue"]);
    expect(url.searchParams.get("visible")).toBe("true");
    expect(url.href).not.toContain(credential);
    expect(headers.get("X-Correlation-Id")).toBe("request-123");
    expect(headers.get("X-Service-Token")).toBe(credential);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(requestInit?.body).toBe(JSON.stringify(input.body));
  });

  it("never interprets an operation path as another URL authority before credentials", async () => {
    for (const operation of authorityPathOperations) {
      const fetchImplementation = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(JSON.stringify({ id: "safe", name: "Safe origin" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      );
      const engine = createRuntime(fetchImplementation);

      await expect(
        engine.invoke(operation.capabilityId, input, { principal: null }),
      ).resolves.toMatchObject({ status: 201 });

      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      const [target, init] = fetchImplementation.mock.calls[0] ?? [];
      expect(new URL(String(target)).origin).toBe("https://api.example.test");
      expect(new Headers(init?.headers).get("X-Service-Token")).toBe(
        credential,
      );
    }
  });

  it("substitutes every occurrence of one declared path placeholder", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ id: "a/b", name: "Repeated" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const engine = createRuntime(fetchImplementation);

    await expect(
      engine.invoke(repeatedPathOperation.capabilityId, input, {
        principal: null,
      }),
    ).resolves.toMatchObject({ status: 201 });

    const [requestTarget] = fetchImplementation.mock.calls[0] ?? [];
    expect(new URL(String(requestTarget)).pathname).toBe(
      "/v1/widgets/a%2Fb/related/a%2Fb",
    );
  });

  it("propagates caller cancellation through the capability to fetch", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetchImplementation: typeof globalThis.fetch = async (
      _request,
      init,
    ) => {
      receivedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener(
          "abort",
          () => reject(receivedSignal?.reason),
          { once: true },
        );
      });
    };
    const engine = createRuntime(fetchImplementation);
    const controller = new AbortController();

    const invocation = engine.invoke(capabilityId, input, {
      principal: null,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    controller.abort();

    await expect(invocation).rejects.toMatchObject({ code: "CANCELLED" });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("preserves simple-array path commas while encoding each member", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ id: "array", name: "Created" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const engine = createRuntime(fetchImplementation);

    await engine.invoke(
      capabilityId,
      {
        ...input,
        path: { widgetId: ["a/b", "c d"] },
      },
      { principal: null },
    );

    const [requestTarget] = fetchImplementation.mock.calls[0] ?? [];
    expect(new URL(String(requestTarget)).pathname).toBe(
      "/v1/widgets/a%2Fb,c%20d",
    );
  });

  it("keeps each form array in one cookie parameter with its explode delimiter", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ id: "cookies", name: "Created" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const engine = createRuntime(fetchImplementation);

    await engine.invoke(
      capabilityId,
      {
        ...input,
        cookies: {
          expanded: ["a/b", "c d"],
          compact: ["x,y", "z"],
        },
      },
      { principal: null },
    );

    const [, requestInit] = fetchImplementation.mock.calls[0] ?? [];
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("cookie")).toBe(
      "expanded=a%2Fb&expanded=c%20d; compact=x%2Cy,z",
    );
  });

  it("validates partial credentials synchronously during connector construction", () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>();

    expect(() =>
      connectorModule.fetchOpenApiConnector.create(
        {
          OPENAPI_REQUIRED_TOKEN: credential,
          OPENAPI_BASIC_USERNAME: "partial",
        },
        { fetch: fetchImplementation },
      ),
    ).toThrow("Connector configuration is invalid.");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("requires credentials for every operation during connector construction", () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>();

    expect(() =>
      connectorModule.fetchOpenApiConnector.create(
        { OPENAPI_SERVICE_TOKEN: credential },
        { fetch: fetchImplementation },
      ),
    ).toThrow("Connector configuration is invalid.");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("rejects non-allowlisted configuration without exposing its value", () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>();
    const secret = "non-allowlisted-secret";
    let failure: unknown;

    try {
      connectorModule.fetchOpenApiConnector.create(
        { ...validConnectorConfig, OPENAPI_UNKNOWN: secret },
        { fetch: fetchImplementation },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe(
      "Connector configuration is invalid.",
    );
    expect(String(failure)).not.toContain(secret);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("defines an inert private connector with frozen named ports", () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>();

    expect(connectorModule.fetchOpenApiConnector.name).toBe(
      "generated-openapi-fetch",
    );
    expect(fetchImplementation).not.toHaveBeenCalled();

    const connector = connectorModule.fetchOpenApiConnector.create(
      validConnectorConfig,
      { fetch: fetchImplementation },
    );
    const engine = engineModule.createOpenApiEngine({ ports: connector.ports });

    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(Object.isFrozen(connector)).toBe(true);
    expect(Object.isFrozen(connector.ports)).toBe(true);
    expect(Object.keys(connector.ports)).toContain("createWidget");
    expect(engine.list().map(({ id }) => id)).toContain(capabilityId);
    expect(engine.list().map(({ id }) => id)).not.toContain(
      connectorModule.fetchOpenApiConnector.name,
    );
  });

  it("keeps credential validation in the executable composition root", async () => {
    const names = [
      "OPENAPI_BASIC_PASSWORD",
      "OPENAPI_BASIC_USERNAME",
      "OPENAPI_REQUIRED_TOKEN",
      "OPENAPI_SERVICE_TOKEN",
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    const engineUrl = pathToFileURL(
      join(projectDirectory, "dist/engine.js"),
    ).href;

    try {
      for (const name of names) delete process.env[name];

      await expect(
        import(`${engineUrl}?configuration=missing`),
      ).rejects.toThrow("Connector configuration is invalid.");

      process.env.OPENAPI_REQUIRED_TOKEN = credential;
      const composition = (await import(
        `${engineUrl}?configuration=valid`
      )) as Readonly<{ readonly engine: GeneratedEngine }>;

      expect(composition.engine.list().map(({ id }) => id)).toContain(
        requiredAuthOperation.capabilityId,
      );
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it.each([
    ["a non-HTTP base URL", "ftp://api.example.test"],
    ["a base URL containing user info", "https://secret@api.example.test"],
  ])(
    "rejects %s before connector construction completes",
    (_label, baseUrl) => {
      const fetchImplementation = vi.fn<typeof globalThis.fetch>();

      expect(() =>
        connectorModule.fetchOpenApiConnector.create(
          {
            OPENAPI_CREATE_WIDGET_BASE_URL: baseUrl,
            ...validConnectorConfig,
          },
          { fetch: fetchImplementation },
        ),
      ).toThrow("Connector configuration is invalid.");
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it("rejects ambiguous complete credential alternatives synchronously", () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>();

    expect(() =>
      connectorModule.fetchOpenApiConnector.create(
        {
          OPENAPI_SERVICE_TOKEN: credential,
          OPENAPI_REQUIRED_TOKEN: credential,
          OPENAPI_BASIC_USERNAME: "user",
          OPENAPI_BASIC_PASSWORD: "password",
        },
        { fetch: fetchImplementation },
      ),
    ).toThrow("Connector configuration is invalid.");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("snapshots configuration before creating operation ports", async () => {
    const config: Record<string, string> = { ...validConnectorConfig };
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ id: "safe", name: "Snapshot" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const connector = connectorModule.fetchOpenApiConnector.create(config, {
      fetch: fetchImplementation,
    });
    config.OPENAPI_SERVICE_TOKEN = "mutated-secret";
    const engine = engineModule.createOpenApiEngine({ ports: connector.ports });

    await engine.invoke(capabilityId, input, { principal: null });

    const [, requestInit] = fetchImplementation.mock.calls[0] ?? [];
    expect(new Headers(requestInit?.headers).get("X-Service-Token")).toBe(
      credential,
    );
  });

  it("translates a schema-invalid external response into a connector failure", async () => {
    const engine = createRuntime(
      async () =>
        new Response(JSON.stringify({ id: "missing-name" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      engine.invoke(capabilityId, input, { principal: null }),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
  });

  it.each([
    [
      "a non-success status",
      () =>
        new Response(leakedBody, {
          status: 403,
          headers: { "content-type": "text/plain" },
        }),
    ],
    [
      "an invalid successful JSON body",
      () =>
        new Response(`{"private":"${leakedBody}`, {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "a successful but undeclared JSON media type",
      () =>
        new Response(JSON.stringify({ private: leakedBody }), {
          status: 201,
          headers: {
            "content-type": "application/problem+json; charset=utf-8",
          },
        }),
    ],
  ])("sanitizes %s", async (_label, response) => {
    const engine = createRuntime(async () => response());

    const error = await capturedFailure(
      engine.invoke(capabilityId, input, { principal: null }),
    );
    expect(error).toMatchObject({ code: "EXECUTION_FAILED" });
    const exposed = `${String(error)} ${JSON.stringify(error)}`;
    expect(exposed).not.toContain(leakedBody);
    expect(exposed).not.toContain(credential);
  });
});
