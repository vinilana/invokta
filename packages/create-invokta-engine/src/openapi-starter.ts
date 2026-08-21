import type { OpenApiStarterOperationPlan } from "./openapi-discovery.js";
import type { PackageManager } from "./package-manager.js";
import {
  createStarterFiles,
  type EngineStarterProfile,
  type StarterEntry,
} from "./starter.js";

export type OpenApiStarterOperation = OpenApiStarterOperationPlan;

export interface CreateOpenApiStarterFilesOptions {
  readonly projectName: string;
  readonly invoktaVersion: string;
  readonly packageManager: PackageManager;
  readonly profile: EngineStarterProfile;
  readonly selectedOperations: readonly OpenApiStarterOperation[];
}

function generatedFile(path: string, contents: string): StarterEntry {
  return Object.freeze({ kind: "file", path, contents });
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function operationBaseUrl(
  operation: OpenApiStarterOperation,
): Readonly<{ environmentVariable: string; default?: string }> {
  const planned = operation.connection.baseUrl;
  if (planned !== undefined) return planned;
  const fallback = operation.connection.serverUrls[0];
  return Object.freeze({
    environmentVariable: "OPENAPI_BASE_URL",
    ...(fallback === undefined ? {} : { default: fallback }),
  });
}

function normalizedOperation(operation: OpenApiStarterOperation): unknown {
  return {
    selector: operation.selector,
    method: operation.method,
    path: operation.path,
    connection: {
      serverSource: operation.connection.serverSource,
      serverUrls: operation.connection.serverUrls,
      baseUrl: operationBaseUrl(operation),
    },
    parameters: operation.parameters,
    requestBody: operation.requestBody,
    successResponses: operation.successResponses,
    security: operation.security,
  };
}

function renderCapability(operation: OpenApiStarterOperation): string {
  const readOnly = operation.method === "GET" || operation.method === "HEAD";
  const idempotent =
    readOnly ||
    operation.method === "PUT" ||
    operation.method === "DELETE" ||
    operation.method === "OPTIONS";
  return `import { defineCapability } from "@invokta/core";
import { z } from "zod";

import type { OpenApiUpstream } from "../openapi/upstream.js";

const inputSchema = z.fromJSONSchema(${json(operation.inputSchema)}) as z.ZodType<
  Record<string, unknown>
>;
const outputSchema = z.fromJSONSchema(${json(operation.outputSchema)});
const operation = ${json(normalizedOperation(operation))} as const;

export function ${operation.exportName}(upstream: OpenApiUpstream) {
  return defineCapability({
    title: ${JSON.stringify(operation.title)},
    description: ${JSON.stringify(operation.description)},
    input: inputSchema,
    output: outputSchema,
    access: "public",
    timeoutMs: 30_000,
    annotations: {
      readOnly: ${String(readOnly)},
      destructive: ${String(operation.method === "DELETE")},
      idempotent: ${String(idempotent)},
      openWorld: true,
    },
    async run({ input, context }) {
      return upstream.invoke({
        operation,
        input,
        signal: context.signal,
      });
    },
  });
}
`;
}

function renderUpstreamPort(): string {
  return `export interface OpenApiParameterPlan {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly style: string;
  readonly explode: boolean;
  readonly schema: unknown;
}

export interface OpenApiSecuritySchemePlan {
  readonly name: string;
  readonly type: "apiKey" | "basic" | "bearer";
  readonly in?: "header" | "query" | "cookie";
  readonly parameterName?: string;
  readonly environmentVariables: Readonly<
    Partial<Record<"value" | "username" | "password" | "token", string>>
  >;
}

export interface OpenApiOperationPlan {
  readonly selector: string;
  readonly method: string;
  readonly path: string;
  readonly connection: Readonly<{
    serverSource: "operation" | "path" | "root" | "default";
    serverUrls: readonly string[];
    baseUrl: Readonly<{
      environmentVariable: string;
      default?: string;
    }>;
  }>;
  readonly parameters: readonly OpenApiParameterPlan[];
  readonly requestBody:
    | Readonly<{
        required: boolean;
        mediaType: "application/json";
        schema: unknown;
      }>
    | undefined;
  readonly successResponses: readonly Readonly<{
    status: string;
    mediaType: string | undefined;
    schema: unknown | undefined;
  }>[];
  readonly security: Readonly<{
    alternatives: readonly (readonly OpenApiSecuritySchemePlan[])[];
  }>;
}

export interface OpenApiUpstreamRequest {
  readonly operation: OpenApiOperationPlan;
  readonly input: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface OpenApiUpstream {
  readonly invoke: (
    request: OpenApiUpstreamRequest,
  ) => Promise<Record<string, unknown>>;
}
`;
}

function renderFetchAdapter(): string {
  return `import { Buffer } from "node:buffer";

import { EngineError } from "@invokta/core";

import type {
  OpenApiOperationPlan,
  OpenApiSecuritySchemePlan,
  OpenApiUpstream,
  OpenApiUpstreamRequest,
} from "./upstream.js";

const maxUrlBytes = 8_192;
const maxRequestBytes = 10 * 1024 * 1024;
const maxResponseBytes = 10 * 1024 * 1024;
const publicFailureMessage = "The upstream API request failed.";
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export interface FetchOpenApiUpstreamOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function failure(): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message: publicFailureMessage,
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw failure();
  }
  return value as Readonly<Record<string, unknown>>;
}

function group(
  input: Readonly<Record<string, unknown>>,
  name: string,
): Readonly<Record<string, unknown>> {
  const value = input[name];
  return value === undefined ? {} : record(value);
}

function scalar(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  throw failure();
}

function simple(value: unknown): string {
  return Array.isArray(value) ? value.map(scalar).join(",") : scalar(value);
}

function simplePath(value: unknown): string {
  return Array.isArray(value)
    ? value.map((member) => encodeURIComponent(scalar(member))).join(",")
    : encodeURIComponent(scalar(value));
}

function addQuery(
  url: URL,
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
): void {
  if (style === "deepObject") {
    for (const [key, member] of Object.entries(record(value)).sort()) {
      url.searchParams.append(\`\${name}[\${key}]\`, scalar(member));
    }
    return;
  }
  if (Array.isArray(value) && explode) {
    for (const member of value) url.searchParams.append(name, scalar(member));
    return;
  }
  url.searchParams.append(name, simple(value));
}

function addCookie(
  cookies: string[],
  name: string,
  value: unknown,
  explode: boolean,
): void {
  const encodedName = encodeURIComponent(name);
  if (Array.isArray(value)) {
    const members = value.map((member) => encodeURIComponent(scalar(member)));
    cookies.push(
      explode
        ? members.map((member) => \`\${encodedName}=\${member}\`).join("&")
        : \`\${encodedName}=\${members.join(",")}\`,
    );
    return;
  }
  cookies.push(\`\${encodedName}=\${encodeURIComponent(scalar(value))}\`);
}

function environmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string | undefined,
): string | undefined {
  if (name === undefined) return undefined;
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function schemeComplete(
  scheme: OpenApiSecuritySchemePlan,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (scheme.type === "apiKey") {
    return environmentValue(env, scheme.environmentVariables.value) !== undefined;
  }
  if (scheme.type === "basic") {
    return (
      environmentValue(env, scheme.environmentVariables.username) !== undefined &&
      environmentValue(env, scheme.environmentVariables.password) !== undefined
    );
  }
  return environmentValue(env, scheme.environmentVariables.token) !== undefined;
}

function schemeConfigured(
  scheme: OpenApiSecuritySchemePlan,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return Object.values(scheme.environmentVariables).some(
    (name) => environmentValue(env, name) !== undefined,
  );
}

function applyScheme(
  scheme: OpenApiSecuritySchemePlan,
  env: Readonly<Record<string, string | undefined>>,
  url: URL,
  headers: Headers,
  cookies: string[],
): void {
  if (scheme.type === "apiKey") {
    const value = environmentValue(env, scheme.environmentVariables.value);
    if (value === undefined || scheme.in === undefined || scheme.parameterName === undefined) {
      throw failure();
    }
    if (scheme.in === "header") headers.set(scheme.parameterName, value);
    else if (scheme.in === "query") url.searchParams.append(scheme.parameterName, value);
    else addCookie(cookies, scheme.parameterName, value, false);
    return;
  }
  if (scheme.type === "basic") {
    const username = environmentValue(env, scheme.environmentVariables.username);
    const password = environmentValue(env, scheme.environmentVariables.password);
    if (username === undefined || password === undefined) throw failure();
    headers.set(
      "authorization",
      \`Basic \${Buffer.from(\`\${username}:\${password}\`, "utf8").toString("base64")}\`,
    );
    return;
  }
  const token = environmentValue(env, scheme.environmentVariables.token);
  if (token === undefined) throw failure();
  headers.set("authorization", \`Bearer \${token}\`);
}

function applySecurity(
  operation: OpenApiOperationPlan,
  env: Readonly<Record<string, string | undefined>>,
  url: URL,
  headers: Headers,
  cookies: string[],
): void {
  const credentialed = operation.security.alternatives.filter(
    (alternative) =>
      alternative.length > 0 && alternative.every((scheme) => schemeComplete(scheme, env)),
  );
  if (credentialed.length > 1) throw failure();
  const selected = credentialed[0];
  if (selected !== undefined) {
    for (const scheme of selected) applyScheme(scheme, env, url, headers, cookies);
    return;
  }
  const partiallyConfigured = operation.security.alternatives.some(
    (alternative) =>
      alternative.length > 0 &&
      alternative.some((scheme) => schemeConfigured(scheme, env)),
  );
  if (partiallyConfigured) throw failure();
  if (operation.security.alternatives.some((alternative) => alternative.length === 0)) {
    return;
  }
  throw failure();
}

function baseUrl(
  operation: OpenApiOperationPlan,
  env: Readonly<Record<string, string | undefined>>,
): URL {
  const configured = environmentValue(
    env,
    operation.connection.baseUrl.environmentVariable,
  );
  const value = configured ?? operation.connection.baseUrl.default;
  if (value === undefined) throw failure();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw failure();
    if (parsed.username !== "" || parsed.password !== "") throw failure();
    return parsed;
  } catch {
    throw failure();
  }
}

function requestUrl(
  operation: OpenApiOperationPlan,
  input: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{ url: URL; headers: Headers; cookies: string[] }> {
  const root = baseUrl(operation, env);
  let path = operation.path;
  const headers = new Headers({ accept: "application/json, application/*+json" });
  const cookies: string[] = [];
  for (const parameter of operation.parameters) {
    const publicGroup =
      parameter.in === "header"
        ? "headers"
        : parameter.in === "cookie"
          ? "cookies"
          : parameter.in;
    const value = group(input, publicGroup)[parameter.name];
    if (value === undefined) {
      if (parameter.required) throw failure();
      continue;
    }
    if (parameter.in === "path") {
      path = path.replace(\`{\${parameter.name}}\`, simplePath(value));
    } else if (parameter.in === "header") {
      headers.set(parameter.name, simple(value));
    }
  }
  if (/\\{[^{}]+\\}/u.test(path)) throw failure();
  const rootWithSlash = root.href.endsWith("/") ? root : new URL(\`\${root.href}/\`);
  const url = new URL(path.replace(/^\\//u, ""), rootWithSlash);
  for (const parameter of operation.parameters) {
    if (parameter.in !== "query" && parameter.in !== "cookie") continue;
    const publicGroup = parameter.in === "cookie" ? "cookies" : "query";
    const value = group(input, publicGroup)[parameter.name];
    if (value === undefined) continue;
    if (parameter.in === "query") {
      addQuery(url, parameter.name, value, parameter.style, parameter.explode);
    } else {
      addCookie(cookies, parameter.name, value, parameter.explode);
    }
  }
  applySecurity(operation, env, url, headers, cookies);
  if (cookies.length > 0) headers.set("cookie", cookies.join("; "));
  if (encoder.encode(url.href).byteLength > maxUrlBytes) throw failure();
  return { url, headers, cookies };
}

function requestBody(
  operation: OpenApiOperationPlan,
  input: Readonly<Record<string, unknown>>,
  headers: Headers,
): string | undefined {
  if (operation.requestBody === undefined) return undefined;
  const value = input.body;
  if (value === undefined) {
    if (operation.requestBody.required) throw failure();
    return undefined;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw failure();
  }
  if (encoder.encode(encoded).byteLength > maxRequestBytes) throw failure();
  headers.set("content-type", operation.requestBody.mediaType);
  return encoded;
}

function expectedResponse(
  operation: OpenApiOperationPlan,
  status: number,
): OpenApiOperationPlan["successResponses"][number] | undefined {
  return operation.successResponses.find(
    (candidate) =>
      candidate.status === String(status) ||
      (candidate.status === "2XX" && status >= 200 && status <= 299),
  );
}

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\\d+$/u.test(declared) && Number(declared) > maxResponseBytes) {
    throw failure();
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw failure();
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function decodeResponse(
  operation: OpenApiOperationPlan,
  response: Response,
): Promise<Record<string, unknown>> {
  const expected = expectedResponse(operation, response.status);
  if (expected === undefined) throw failure();
  const bytes = await readBounded(response);
  if (expected.mediaType === undefined) {
    if (bytes.byteLength !== 0) throw failure();
    return { status: response.status };
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType === undefined) throw failure();
  if (contentType.toLowerCase() !== expected.mediaType.toLowerCase()) throw failure();
  try {
    const body: unknown = JSON.parse(decoder.decode(bytes));
    return { status: response.status, body };
  } catch {
    throw failure();
  }
}

export function createFetchOpenApiUpstream(
  options: FetchOpenApiUpstreamOptions,
): OpenApiUpstream {
  return Object.freeze({
    async invoke(request: OpenApiUpstreamRequest) {
      const input = record(request.input);
      const target = requestUrl(request.operation, input, options.env);
      const body = requestBody(request.operation, input, target.headers);
      let response: Response;
      try {
        response = await options.fetch(target.url, {
          method: request.operation.method,
          headers: target.headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal.aborted) throw error;
        throw failure();
      }
      return decodeResponse(request.operation, response);
    },
  });
}
`;
}

function renderEngine(
  projectName: string,
  operations: readonly OpenApiStarterOperation[],
): string {
  const imports = operations
    .map(
      (operation) =>
        `import { ${operation.exportName} } from "./capabilities/${operation.moduleName}.js";`,
    )
    .join("\n");
  const registrations = operations
    .map(
      (operation) =>
        `      ${JSON.stringify(operation.capabilityId)}: ${operation.exportName}(upstream),`,
    )
    .join("\n");
  return `import { createEngine } from "@invokta/core";

${imports}
import { createFetchOpenApiUpstream } from "./openapi/fetch-adapter.js";
import type { OpenApiUpstream } from "./openapi/upstream.js";

export interface CreateOpenApiEngineOptions {
  readonly upstream: OpenApiUpstream;
}

export function createOpenApiEngine({ upstream }: CreateOpenApiEngineOptions) {
  return createEngine({
    name: ${JSON.stringify(projectName)},
    version: "0.1.0",
    capabilities: {
${registrations}
    },
  });
}

export const engine = createOpenApiEngine({
  upstream: createFetchOpenApiUpstream({
    fetch: globalThis.fetch,
    env: process.env,
  }),
});
`;
}

function renderDirect(capabilityId: string): string {
  return `import { engine } from "./engine.js";

function parseInput(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Input must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

const input = parseInput(process.argv[2] ?? "{}");
const result = await engine.invoke(
  ${JSON.stringify(capabilityId)},
  input,
  { source: "direct", principal: null },
);

process.stdout.write(\`\${JSON.stringify(result)}\\n\`);
`;
}

function renderGeneratedTest(
  operations: readonly OpenApiStarterOperation[],
): string {
  const first = operations[0];
  if (first === undefined)
    throw new TypeError("At least one operation is required.");
  return `import { describe, expect, it } from "vitest";

import { createOpenApiEngine } from "../src/engine.js";
import type { OpenApiUpstream } from "../src/openapi/upstream.js";

describe("generated OpenAPI engine", () => {
  it("delegates through the injected upstream port", async () => {
    const upstream: OpenApiUpstream = {
      async invoke(request) {
        expect(request.operation.selector).toBe(${JSON.stringify(first.selector)});
        return { status: 204 };
      },
    };
    const engine = createOpenApiEngine({ upstream });

    await expect(
      engine.invoke(${JSON.stringify(first.capabilityId)}, {}, { principal: null }),
    ).resolves.toEqual({ status: 204 });
  });
});
`;
}

function adaptReadme(
  contents: string,
  operations: readonly OpenApiStarterOperation[],
): string {
  const first = operations[0];
  if (first === undefined)
    throw new TypeError("At least one operation is required.");
  return contents
    .replace(
      "with one\ndeterministic capability",
      `with ${String(operations.length)} generated OpenAPI capabilities`,
    )
    .replaceAll("onboarding.create-welcome-message", first.capabilityId)
    .replace('--input \'{"name":"Ada"}\'', "--input '{}'");
}

const reviewInstruction =
  "Review every generated capability's domain meaning and access rule before deployment.";

function appendReviewInstruction(contents: string): string {
  return `${contents.trimEnd()}\n\n${reviewInstruction}\n`;
}

function adaptMcpHttpModule(contents: string): string {
  return contents
    .replace(
      'import { serveMcpHttp } from "@invokta/mcp";\n',
      'import { serveMcpHttp } from "@invokta/mcp";\n\nimport { engine } from "./engine.js";\n',
    )
    .replace('  const { engine } = await import("./engine.js");\n', "");
}

function environmentNames(
  operations: readonly OpenApiStarterOperation[],
): readonly string[] {
  const names = new Set<string>();
  for (const operation of operations) {
    names.add(operationBaseUrl(operation).environmentVariable);
    for (const alternative of operation.security.alternatives) {
      for (const scheme of alternative) {
        for (const value of Object.values(scheme.environmentVariables)) {
          if (value !== undefined) names.add(value);
        }
      }
    }
  }
  return Object.freeze([...names].sort());
}

function replaceManifest(
  contents: string,
  operations: readonly OpenApiStarterOperation[],
  envNames: readonly string[],
): string {
  const manifest = JSON.parse(contents) as {
    capabilityIds: string[];
    server: { forwardEnv: string[] };
  };
  manifest.capabilityIds = operations.map(
    (operation) => operation.capabilityId,
  );
  manifest.server.forwardEnv = [...envNames];
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function compareEntries(left: StarterEntry, right: StarterEntry): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

/** Returns a deterministic source-only starter for selected OpenAPI operations. */
export function createOpenApiStarterFiles(
  options: CreateOpenApiStarterFilesOptions,
): readonly StarterEntry[] {
  if (options.selectedOperations.length === 0) {
    throw new TypeError("At least one selected OpenAPI operation is required.");
  }
  const operations = Object.freeze([...options.selectedOperations]);
  const first = operations[0];
  if (first === undefined) {
    throw new TypeError("At least one selected OpenAPI operation is required.");
  }
  const envNames = environmentNames(operations);
  const replacements = new Map<string, StarterEntry>();
  for (const entry of createStarterFiles(options)) {
    if (entry.path === "src/capabilities/create-welcome-message.ts") continue;
    if (entry.path === "src/engine.ts") {
      replacements.set(
        entry.path,
        generatedFile(
          entry.path,
          renderEngine(options.projectName, operations),
        ),
      );
      continue;
    }
    if (entry.path === "src/direct.ts") {
      replacements.set(
        entry.path,
        generatedFile(entry.path, renderDirect(first.capabilityId)),
      );
      continue;
    }
    if (entry.path === "test/engine.test.ts") {
      replacements.set(
        entry.path,
        generatedFile(entry.path, renderGeneratedTest(operations)),
      );
      continue;
    }
    if (entry.path === "README.md" && entry.kind === "file") {
      replacements.set(
        entry.path,
        generatedFile(
          entry.path,
          appendReviewInstruction(adaptReadme(entry.contents, operations)),
        ),
      );
      continue;
    }
    if (
      (entry.path === "AGENTS.md" ||
        entry.path === ".agents/skills/develop-invokta-project/SKILL.md") &&
      entry.kind === "file"
    ) {
      replacements.set(
        entry.path,
        generatedFile(entry.path, appendReviewInstruction(entry.contents)),
      );
      continue;
    }
    if (entry.path === "src/mcp-http.ts" && entry.kind === "file") {
      replacements.set(
        entry.path,
        generatedFile(entry.path, adaptMcpHttpModule(entry.contents)),
      );
      continue;
    }
    if (entry.path === "invokta.mcp.json" && entry.kind === "file") {
      replacements.set(
        entry.path,
        generatedFile(
          entry.path,
          replaceManifest(entry.contents, operations, envNames),
        ),
      );
      continue;
    }
    replacements.set(entry.path, entry);
  }
  for (const operation of operations) {
    const path = `src/capabilities/${operation.moduleName}.ts`;
    replacements.set(path, generatedFile(path, renderCapability(operation)));
  }
  for (const entry of [
    generatedFile("src/openapi/fetch-adapter.ts", renderFetchAdapter()),
    generatedFile("src/openapi/upstream.ts", renderUpstreamPort()),
    generatedFile(
      "upstream.env.example",
      `${envNames.map((name) => `${name}=`).join("\n")}\n`,
    ),
  ]) {
    replacements.set(entry.path, entry);
  }
  const entries = [...replacements.values()].sort(compareEntries);
  return Object.freeze(entries);
}
