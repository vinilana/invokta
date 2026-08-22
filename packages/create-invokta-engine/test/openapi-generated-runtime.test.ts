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
  schema: Object.freeze({ type: "string", pattern: "^z{17}$" }),
});

interface GeneratedUpstream {
  readonly invoke: (request: unknown) => Promise<Record<string, unknown>>;
}

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
}

interface GeneratedEngineModule {
  readonly createOpenApiEngine: (options: {
    readonly upstream: GeneratedUpstream;
  }) => GeneratedEngine;
}

interface GeneratedAdapterModule {
  readonly createFetchOpenApiUpstream: (options: {
    readonly fetch: typeof globalThis.fetch;
    readonly env: Readonly<Record<string, string | undefined>>;
  }) => GeneratedUpstream;
}

const input = Object.freeze({
  path: Object.freeze({ widgetId: "a/b" }),
  query: Object.freeze({ tags: Object.freeze(["red", "blue"]), visible: true }),
  headers: Object.freeze({ "X-Correlation-Id": "request-123" }),
  body: Object.freeze({ id: "a/b", name: "Ada" }),
});

let projectDirectory: string;
let engineModule: GeneratedEngineModule;
let adapterModule: GeneratedAdapterModule;

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
  const upstream = adapterModule.createFetchOpenApiUpstream({
    fetch: fetchImplementation,
    env: Object.freeze({ OPENAPI_SERVICE_TOKEN: credential }),
  });
  return engineModule.createOpenApiEngine({ upstream });
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
      ]),
    }),
    projectDirectory,
  );
  symlinkSync(nodeModulesPath, join(projectDirectory, "node_modules"), "dir");
  compileGeneratedProject();
  engineModule = (await import(
    pathToFileURL(join(projectDirectory, "dist/engine.js")).href
  )) as GeneratedEngineModule;
  adapterModule = (await import(
    pathToFileURL(join(projectDirectory, "dist/openapi/fetch-adapter.js")).href
  )) as GeneratedAdapterModule;
});

afterAll(() => {
  if (projectDirectory !== undefined) {
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

describe("generated OpenAPI runtime", () => {
  it("publishes a literal object root for multiple successful responses", () => {
    const engine = engineModule.createOpenApiEngine({
      upstream: {
        async invoke() {
          return { status: 204 };
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
    for (const path of [
      "///collector.example/steal",
      "/\\\\collector.example/steal",
      "https://collector.example/steal",
    ]) {
      const fetchImplementation = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(JSON.stringify({ id: "safe", name: "Safe origin" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      );
      const upstream = adapterModule.createFetchOpenApiUpstream({
        fetch: fetchImplementation,
        env: Object.freeze({ OPENAPI_SERVICE_TOKEN: credential }),
      });
      const operation = { ...createWidgetOperation, path };

      await expect(
        upstream.invoke({
          operation,
          input,
          signal: new AbortController().signal,
        }),
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
    const upstream = adapterModule.createFetchOpenApiUpstream({
      fetch: fetchImplementation,
      env: Object.freeze({ OPENAPI_SERVICE_TOKEN: credential }),
    });

    await expect(
      upstream.invoke({
        operation: {
          ...createWidgetOperation,
          path: "/widgets/{widgetId}/related/{widgetId}",
        },
        input,
        signal: new AbortController().signal,
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

  it("fails closed instead of using anonymous auth when credentials are partial", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>();
    const upstream = adapterModule.createFetchOpenApiUpstream({
      fetch: fetchImplementation,
      env: Object.freeze({ OPENAPI_BASIC_USERNAME: "partial" }),
    });
    const engine = engineModule.createOpenApiEngine({ upstream });

    await expect(
      engine.invoke(capabilityId, input, { principal: null }),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
    expect(fetchImplementation).not.toHaveBeenCalled();
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
