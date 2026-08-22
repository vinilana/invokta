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

function portTypeName(operation: OpenApiStarterOperation): string {
  return `${operation.exportName[0]?.toUpperCase() ?? ""}${operation.exportName.slice(1)}Port`;
}

function renderCapability(operation: OpenApiStarterOperation): string {
  const readOnly = operation.method === "GET" || operation.method === "HEAD";
  const idempotent =
    readOnly ||
    operation.method === "PUT" ||
    operation.method === "DELETE" ||
    operation.method === "OPTIONS";
  return `import { defineCapability, type EngineSchema } from "@invokta/core";
import { z } from "zod";

import type { ${portTypeName(operation)} } from "../openapi/ports.js";

function schemaContract(
  schema: Readonly<Record<string, unknown>>,
): EngineSchema<Record<string, unknown>, Record<string, unknown>> {
  const validator = z.fromJSONSchema(schema) as z.ZodType<Record<string, unknown>>;
  return {
    "~standard": {
      version: 1,
      vendor: "invokta-generated-openapi",
      validate(value) {
        return validator["~standard"].validate(value);
      },
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
    },
  };
}

const inputSchema = schemaContract(${json(operation.inputSchema)});
const outputSchema = schemaContract(${json(operation.outputSchema)});
export function ${operation.exportName}(port: ${portTypeName(operation)}) {
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
      return port.invoke(input, {
        signal: context.signal,
      });
    },
  });
}
`;
}

function renderPorts(operations: readonly OpenApiStarterOperation[]): string {
  const aliases = operations
    .map(
      (operation) =>
        `export type ${portTypeName(operation)} = OpenApiOperationPort;`,
    )
    .join("\n");
  const members = operations
    .map(
      (operation) =>
        `  readonly ${operation.exportName}: ${portTypeName(operation)};`,
    )
    .join("\n");
  return `export interface OpenApiOperationPort {
  readonly invoke: (
    input: Readonly<Record<string, unknown>>,
    options: Readonly<{ readonly signal: AbortSignal }>,
  ) => Promise<Record<string, unknown>>;
}

${aliases}

export interface OpenApiPorts {
${members}
}
`;
}

function renderFetchConnector(
  operations: readonly OpenApiStarterOperation[],
  envNames: readonly string[],
): string {
  const operationConstants = operations
    .map(
      (
        operation,
      ) => `const ${operation.exportName}Operation = ${json(normalizedOperation(operation))} as const;
const ${operation.exportName}OutputValidator = z.fromJSONSchema(${json(operation.outputSchema)}) as z.ZodType<Record<string, unknown>>;`,
    )
    .join("\n\n");
  const configurationChecks = operations
    .map(
      (operation) =>
        `    validateConfiguration(${operation.exportName}Operation, config);`,
    )
    .join("\n");
  const configShape = envNames
    .map((name) => `    ${JSON.stringify(name)}: z.string().min(1).optional(),`)
    .join("\n");
  const portMembers = operations
    .map(
      (operation) => `      ${operation.exportName}: createPort(
        ${operation.exportName}Operation,
        ${operation.exportName}OutputValidator,
        config,
        dependencies.fetch,
      ),`,
    )
    .join("\n");
  return `import { Buffer } from "node:buffer";

import { EngineError, defineConnector } from "@invokta/core";
import { z } from "zod";

import type { OpenApiOperationPort } from "./ports.js";

interface OpenApiParameterPlan {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly style: string;
  readonly explode: boolean;
  readonly schema: unknown;
}

interface OpenApiSecuritySchemePlan {
  readonly name: string;
  readonly type: "apiKey" | "basic" | "bearer";
  readonly in?: "header" | "query" | "cookie";
  readonly parameterName?: string;
  readonly environmentVariables: Readonly<
    Partial<Record<"value" | "username" | "password" | "token", string>>
  >;
}

interface OpenApiOperationPlan {
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
  readonly requestBody?: Readonly<{
    required: boolean;
    mediaType: "application/json";
    schema: unknown;
  }>;
  readonly successResponses: readonly Readonly<{
    status: string;
    mediaType?: string;
    schema?: unknown;
  }>[];
  readonly security: Readonly<{
    alternatives: readonly (readonly OpenApiSecuritySchemePlan[])[];
  }>;
}

export interface FetchOpenApiConnectorDependencies {
  readonly fetch: typeof globalThis.fetch;
}

${operationConstants}

const maxUrlBytes = 8_192;
const maxRequestBytes = 10 * 1024 * 1024;
const maxResponseBytes = 10 * 1024 * 1024;
const publicFailureMessage = "The upstream API request failed.";
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function failure(): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message: publicFailureMessage,
  });
}

function configurationFailure(): TypeError {
  return new TypeError("Invalid generated OpenAPI connector configuration.");
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
      throw configurationFailure();
    }
    if (scheme.in === "header") headers.set(scheme.parameterName, value);
    else if (scheme.in === "query") url.searchParams.append(scheme.parameterName, value);
    else addCookie(cookies, scheme.parameterName, value, false);
    return;
  }
  if (scheme.type === "basic") {
    const username = environmentValue(env, scheme.environmentVariables.username);
    const password = environmentValue(env, scheme.environmentVariables.password);
    if (username === undefined || password === undefined) throw configurationFailure();
    headers.set(
      "authorization",
      \`Basic \${Buffer.from(\`\${username}:\${password}\`, "utf8").toString("base64")}\`,
    );
    return;
  }
  const token = environmentValue(env, scheme.environmentVariables.token);
  if (token === undefined) throw configurationFailure();
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
  if (credentialed.length > 1) throw configurationFailure();
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
  if (partiallyConfigured) throw configurationFailure();
  if (operation.security.alternatives.some((alternative) => alternative.length === 0)) {
    return;
  }
  throw configurationFailure();
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
  if (value === undefined) throw configurationFailure();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw configurationFailure();
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw configurationFailure();
    }
    return parsed;
  } catch {
    throw configurationFailure();
  }
}

function validateConfiguration(
  operation: OpenApiOperationPlan,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const url = baseUrl(operation, env);
  applySecurity(operation, env, url, new Headers(), []);
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
      path = path.replaceAll(\`{\${parameter.name}}\`, simplePath(value));
    } else if (parameter.in === "header") {
      headers.set(parameter.name, simple(value));
    }
  }
  if (/\\{[^{}]+\\}/u.test(path)) throw failure();
  const rootPath = root.pathname.endsWith("/") ? root.pathname : \`\${root.pathname}/\`;
  const operationPath = path.replace(/^\\/+/u, "");
  const url = new URL(root.href);
  url.pathname = \`\${rootPath}\${operationPath}\`;
  url.search = "";
  url.hash = "";
  if (url.origin !== root.origin) throw failure();
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
  if (url.origin !== root.origin) throw failure();
  applySecurity(operation, env, url, headers, cookies);
  if (url.origin !== root.origin) throw failure();
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

function createPort(
  operation: OpenApiOperationPlan,
  outputValidator: z.ZodType<Record<string, unknown>>,
  config: Readonly<Record<string, string | undefined>>,
  fetchImplementation: typeof globalThis.fetch,
): OpenApiOperationPort {
  const port: OpenApiOperationPort = {
    async invoke(inputValue, options) {
      const input = record(inputValue);
      const target = requestUrl(operation, input, config);
      const body = requestBody(operation, input, target.headers);
      let response: Response;
      try {
        response = await fetchImplementation(target.url, {
          method: operation.method,
          headers: target.headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal.aborted) throw error;
        throw failure();
      }
      const output = await decodeResponse(operation, response);
      const validated = outputValidator.safeParse(output);
      if (!validated.success) throw failure();
      return record(validated.data);
    },
  };
  return Object.freeze(port);
}

const openApiConnectorConfig = z
  .object({
${configShape}
  })
  .strict()
  .superRefine((config, context) => {
    try {
${configurationChecks}
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid generated OpenAPI connector configuration.",
      });
    }
  });

export const fetchOpenApiConnector = defineConnector({
  name: "generated-openapi-fetch",
  config: openApiConnectorConfig,
  create(config, dependencies: FetchOpenApiConnectorDependencies) {
    return {
      ports: {
${portMembers}
      },
    };
  },
});
`;
}

function renderOpenApiEngine(
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
        `      ${JSON.stringify(operation.capabilityId)}: ${operation.exportName}(ports.${operation.exportName}),`,
    )
    .join("\n");
  return `import { createEngine } from "@invokta/core";

${imports}
import type { OpenApiPorts } from "./openapi/ports.js";

export interface CreateOpenApiEngineOptions {
  readonly ports: OpenApiPorts;
}

export function createOpenApiEngine({ ports }: CreateOpenApiEngineOptions) {
  return createEngine({
    name: ${JSON.stringify(projectName)},
    version: "0.1.0",
    capabilities: {
${registrations}
    },
  });
}
`;
}

function renderEngine(envNames: readonly string[]): string {
  return `import { createOpenApiEngine } from "./openapi-engine.js";
import { fetchOpenApiConnector } from "./openapi/connector.js";

function connectorConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const config: Record<string, string> = {};
  for (const name of ${json(envNames)} as readonly string[]) {
    const value = env[name];
    if (value !== undefined && value !== "") config[name] = value;
  }
  return config;
}

const connector = fetchOpenApiConnector.create(
  connectorConfigFromEnv(process.env),
  { fetch: globalThis.fetch },
);

export const engine = createOpenApiEngine({
  ports: connector.ports,
});
`;
}

function renderStartupModule(): string {
  return `const diagnostic = Object.freeze({
  code: "EXECUTION_FAILED",
  message: "Connector configuration is invalid.",
});

export function reportConnectorConfigurationFailure(error: unknown): boolean {
  if (
    !(error instanceof TypeError) ||
    error.message !== diagnostic.message
  ) {
    return false;
  }
  process.stderr.write(\`\${JSON.stringify(diagnostic)}\\n\`);
  process.exitCode = 1;
  return true;
}
`;
}

function renderDirect(operation: OpenApiStarterOperation): string {
  let defaultInput: unknown;
  try {
    defaultInput = sampleJsonSchema(operation.inputSchema);
  } catch {
    defaultInput = undefined;
  }
  const inputFallback =
    defaultInput === undefined
      ? `(() => { throw new TypeError("A JSON input argument is required."); })()`
      : JSON.stringify(JSON.stringify(defaultInput));
  return `import { reportConnectorConfigurationFailure } from "./openapi/startup.js";

function parseInput(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Input must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

try {
  const input = parseInput(process.argv[2] ?? ${inputFallback});
  const { engine } = await import("./engine.js");
  const result = await engine.invoke(
    ${JSON.stringify(operation.capabilityId)},
    input,
    { source: "direct", principal: null },
  );

  process.stdout.write(\`\${JSON.stringify(result)}\\n\`);
} catch (error) {
  if (!reportConnectorConfigurationFailure(error)) throw error;
}
`;
}

function renderCli(): string {
  return `import { runCli } from "@invokta/cli";

import { reportConnectorConfigurationFailure } from "./openapi/startup.js";

try {
  const { engine } = await import("./engine.js");
  process.exitCode = await runCli(engine, { principal: null });
} catch (error) {
  if (!reportConnectorConfigurationFailure(error)) throw error;
}
`;
}

function renderMcpStdio(): string {
  return `import { serveMcpStdio } from "@invokta/mcp";

import { reportConnectorConfigurationFailure } from "./openapi/startup.js";

try {
  const { engine } = await import("./engine.js");
  await serveMcpStdio(engine, { principal: null });
} catch (error) {
  if (!reportConnectorConfigurationFailure(error)) throw error;
}
`;
}

function asSchemaObject(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function sampleNumber(schema: Readonly<Record<string, unknown>>): number {
  const multiple =
    typeof schema.multipleOf === "number" && schema.multipleOf > 0
      ? schema.multipleOf
      : 1;
  const minimum =
    typeof schema.minimum === "number"
      ? schema.minimum
      : typeof schema.exclusiveMinimum === "number"
        ? schema.exclusiveMinimum + multiple
        : 0;
  let value = Math.ceil(minimum / multiple) * multiple;
  if (
    typeof schema.exclusiveMinimum === "number" &&
    value <= schema.exclusiveMinimum
  ) {
    value += multiple;
  }
  if (schema.type === "integer") value = Math.ceil(value);
  return value;
}

const witnessUnitLimit = 4_096;

interface WitnessBudget {
  remaining: number;
}

function consumeWitnessUnits(budget: WitnessBudget, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > budget.remaining) {
    throw new TypeError("A generated OpenAPI test value could not be derived.");
  }
  budget.remaining -= count;
}

function spendWitnessUnits(budget: WitnessBudget, count = 1): boolean {
  if (!Number.isSafeInteger(count) || count < 0 || count > budget.remaining) {
    return false;
  }
  budget.remaining -= count;
  return true;
}

function sampleString(
  schema: Readonly<Record<string, unknown>>,
  budget: WitnessBudget,
): string {
  if (schema.pattern !== undefined) {
    throw new TypeError("A generated OpenAPI test value could not be derived.");
  }
  const minimum =
    typeof schema.minLength === "number" ? Math.max(0, schema.minLength) : 0;
  const maximum =
    typeof schema.maxLength === "number"
      ? Math.max(0, schema.maxLength)
      : Number.POSITIVE_INFINITY;
  if (minimum > maximum) {
    throw new TypeError("A generated OpenAPI test value could not be derived.");
  }
  if (minimum > budget.remaining) {
    throw new TypeError("A generated OpenAPI test value could not be derived.");
  }
  if (minimum === 0) return "";
  const length = Math.max(1, minimum);
  if (length <= maximum) {
    consumeWitnessUnits(budget, length);
    return "x".repeat(length);
  }
  throw new TypeError("A generated OpenAPI test value could not be derived.");
}

function jsonValuesEqual(
  left: unknown,
  right: unknown,
  budget: WitnessBudget,
): boolean {
  if (!spendWitnessUnits(budget)) return false;
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (const [index, member] of left.entries()) {
      if (!jsonValuesEqual(member, right[index], budget)) return false;
    }
    return true;
  }
  const leftObject = asSchemaObject(left);
  const rightObject = asSchemaObject(right);
  if (leftObject === undefined || rightObject === undefined) return false;
  let leftCount = 0;
  let rightCount = 0;
  for (const name in leftObject) {
    if (!Object.hasOwn(leftObject, name)) continue;
    leftCount += 1;
    if (
      !Object.hasOwn(rightObject, name) ||
      !jsonValuesEqual(leftObject[name], rightObject[name], budget)
    ) {
      return false;
    }
  }
  for (const name in rightObject) {
    if (Object.hasOwn(rightObject, name)) rightCount += 1;
  }
  return leftCount === rightCount;
}

function valueHasType(value: unknown, type: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "integer")
    return typeof value === "number" && Number.isInteger(value);
  return typeof type === "string" && typeof value === type;
}

function witnessMatches(
  schemaValue: unknown,
  value: unknown,
  budget: WitnessBudget,
): boolean {
  budget.remaining -= 1;
  if (budget.remaining < 0) return false;
  if (schemaValue === true) return true;
  if (schemaValue === false) return false;
  const schema = asSchemaObject(schemaValue);
  if (schema === undefined) return false;
  if (schema.format !== undefined || schema.pattern !== undefined) return false;

  if (
    Object.hasOwn(schema, "const") &&
    !jsonValuesEqual(value, schema.const, budget)
  )
    return false;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((member) => jsonValuesEqual(value, member, budget))
  ) {
    return false;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    schema.type !== undefined &&
    !types.some((type) => valueHasType(value, type))
  ) {
    return false;
  }
  if (
    Array.isArray(schema.allOf) &&
    !schema.allOf.every((member) => witnessMatches(member, value, budget))
  ) {
    return false;
  }
  if (
    Array.isArray(schema.anyOf) &&
    !schema.anyOf.some((member) => witnessMatches(member, value, budget))
  ) {
    return false;
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const member of schema.oneOf) {
      if (witnessMatches(member, value, budget)) matches += 1;
      if (matches > 1) return false;
    }
    if (matches !== 1) return false;
  }

  if (typeof value === "string") {
    let length = 0;
    for (const _character of value) {
      if (!spendWitnessUnits(budget)) return false;
      length += 1;
    }
    if (typeof schema.minLength === "number" && length < schema.minLength)
      return false;
    if (typeof schema.maxLength === "number" && length > schema.maxLength)
      return false;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    if (typeof schema.minimum === "number" && value < schema.minimum)
      return false;
    if (typeof schema.maximum === "number" && value > schema.maximum)
      return false;
    if (
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    ) {
      return false;
    }
    if (
      typeof schema.exclusiveMaximum === "number" &&
      value >= schema.exclusiveMaximum
    ) {
      return false;
    }
    if (
      typeof schema.multipleOf === "number" &&
      value % schema.multipleOf !== 0
    ) {
      return false;
    }
  }
  if (Array.isArray(value)) {
    if (!spendWitnessUnits(budget, value.length)) return false;
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      return false;
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    for (const [index, member] of value.entries()) {
      const itemSchema = prefix[index] ?? schema.items;
      if (
        itemSchema !== undefined &&
        !witnessMatches(itemSchema, member, budget)
      ) {
        return false;
      }
    }
  }
  const object = asSchemaObject(value);
  if (object !== undefined) {
    const properties = asSchemaObject(schema.properties) ?? {};
    if (
      Array.isArray(schema.required) &&
      schema.required.some(
        (name) => typeof name === "string" && !Object.hasOwn(object, name),
      )
    ) {
      return false;
    }
    for (const name in object) {
      if (!Object.hasOwn(object, name)) continue;
      if (!spendWitnessUnits(budget)) return false;
      const member = object[name];
      if (Object.hasOwn(properties, name)) {
        if (!witnessMatches(properties[name], member, budget)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (
        schema.additionalProperties !== undefined &&
        !witnessMatches(schema.additionalProperties, member, budget)
      ) {
        return false;
      }
    }
  }
  return true;
}

function sampleJsonSchemaCandidate(
  schemaValue: unknown,
  budget: WitnessBudget,
): unknown {
  consumeWitnessUnits(budget, 1);
  if (schemaValue === true) return null;
  if (schemaValue === false) {
    throw new TypeError("A generated OpenAPI test value could not be derived.");
  }
  const schema = asSchemaObject(schemaValue);
  if (schema === undefined) return null;
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return schema.enum[0];
  if (Object.hasOwn(schema, "default")) return schema.default;

  for (const union of [schema.oneOf, schema.anyOf]) {
    if (Array.isArray(union) && union.length > 0) {
      for (const member of union) {
        try {
          return sampleJsonSchemaCandidate(member, budget);
        } catch {
          // Try the next declared alternative.
        }
      }
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return sampleJsonSchemaCandidate(schema.allOf[0], budget);
  }

  const declaredTypes = Array.isArray(schema.type)
    ? schema.type
    : [schema.type];
  const type = declaredTypes.find((value) => value !== "null");
  if (type === "object" || schema.properties !== undefined) {
    const properties = asSchemaObject(schema.properties) ?? {};
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    if (!Array.isArray(schema.required)) return result;
    for (const name of schema.required) {
      if (typeof name !== "string") continue;
      consumeWitnessUnits(budget, 1);
      result[name] = sampleJsonSchemaCandidate(properties[name], budget);
    }
    return result;
  }
  if (type === "array" || schema.items !== undefined) {
    const minimum =
      typeof schema.minItems === "number" ? Math.max(0, schema.minItems) : 0;
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    const length = Math.max(minimum, prefix.length);
    const maximum =
      typeof schema.maxItems === "number"
        ? Math.max(0, schema.maxItems)
        : Number.POSITIVE_INFINITY;
    if (length > maximum) {
      throw new TypeError(
        "A generated OpenAPI test value could not be derived.",
      );
    }
    consumeWitnessUnits(budget, length);
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      result.push(
        sampleJsonSchemaCandidate(
          prefix[index] ?? schema.items ?? true,
          budget,
        ),
      );
    }
    return result;
  }
  if (type === "string") return sampleString(schema, budget);
  if (type === "integer" || type === "number") return sampleNumber(schema);
  if (type === "boolean") return false;
  if (type === "null") return null;
  return null;
}

function sampleJsonSchema(schemaValue: unknown): unknown {
  const proofBudget = { remaining: witnessUnitLimit };
  const schema = asSchemaObject(schemaValue);
  const proven = (candidate: unknown): boolean =>
    witnessMatches(schemaValue, candidate, proofBudget);
  if (schema !== undefined) {
    if (Object.hasOwn(schema, "const") && proven(schema.const)) {
      return schema.const;
    }
    if (Array.isArray(schema.enum)) {
      for (const member of schema.enum) {
        if (proven(member)) return member;
      }
    }
    if (Object.hasOwn(schema, "default") && proven(schema.default)) {
      return schema.default;
    }
  }
  try {
    const candidate = sampleJsonSchemaCandidate(schemaValue, {
      remaining: witnessUnitLimit,
    });
    if (proven(candidate)) return candidate;
  } catch {
    // A declared const, enum member, or default can still be a proven witness.
  }
  throw new TypeError("A generated OpenAPI test value could not be derived.");
}

function witnessValueFitsBudget(
  value: unknown,
  budget: WitnessBudget,
): boolean {
  if (!spendWitnessUnits(budget)) return false;
  if (typeof value === "string") {
    for (const _character of value) {
      if (!spendWitnessUnits(budget)) return false;
    }
    return true;
  }
  if (Array.isArray(value)) {
    for (const member of value) {
      if (!witnessValueFitsBudget(member, budget)) return false;
    }
    return true;
  }
  const object = asSchemaObject(value);
  if (object === undefined) return true;
  for (const name in object) {
    if (!Object.hasOwn(object, name)) continue;
    if (
      !spendWitnessUnits(budget) ||
      !witnessValueFitsBudget(object[name], budget)
    ) {
      return false;
    }
  }
  return true;
}

function renderGeneratedTest(
  operations: readonly OpenApiStarterOperation[],
): string {
  const contractCases = operations.map((operation) => ({
    capabilityId: operation.capabilityId,
    portName: operation.exportName,
    selector: operation.selector,
  }));
  const successCases: Array<Record<string, unknown>> = [];
  for (const operation of operations) {
    let input: unknown;
    try {
      input = sampleJsonSchema(operation.inputSchema);
    } catch {
      continue;
    }
    for (const response of operation.successResponses) {
      const status = response.status === "2XX" ? 200 : Number(response.status);
      try {
        const output = {
          status,
          ...(response.mediaType === undefined
            ? {}
            : {
                body:
                  response.schema === undefined
                    ? null
                    : sampleJsonSchema(response.schema),
              }),
        };
        if (
          !witnessMatches(operation.outputSchema, output, {
            remaining: witnessUnitLimit,
          })
        ) {
          continue;
        }
        const sourceBudget = { remaining: witnessUnitLimit };
        if (
          !witnessValueFitsBudget(input, sourceBudget) ||
          !witnessValueFitsBudget(output, sourceBudget)
        ) {
          continue;
        }
        successCases.push({
          capabilityId: operation.capabilityId,
          portName: operation.exportName,
          selector: operation.selector,
          input,
          status: response.status,
          output,
        });
      } catch {
        // No successful invocation is emitted without a proven output witness.
      }
    }
  }
  const fakePortMembers = operations
    .map(
      (operation) =>
        `    ${operation.exportName}: { invoke: target === ${JSON.stringify(operation.exportName)} ? invoke : async () => ({}) },`,
    )
    .join("\n");
  return `import { describe, expect, it, vi } from "vitest";

import { createOpenApiEngine } from "../src/openapi-engine.js";
import type {
  OpenApiOperationPort,
  OpenApiPorts,
} from "../src/openapi/ports.js";

function fakePorts(
  target: keyof OpenApiPorts,
  invoke: OpenApiOperationPort["invoke"],
): OpenApiPorts {
  return {
${fakePortMembers}
  };
}

describe("generated OpenAPI engine", () => {
  it.each(${json(contractCases)} as const)(
    "validates $selector contract without calling upstream",
    async ({ capabilityId, portName }) => {
      const invoke = vi.fn(async () => ({}));
      const engine = createOpenApiEngine({
        ports: fakePorts(portName as keyof OpenApiPorts, invoke),
      });

      expect(engine.describe(capabilityId)).toMatchObject({
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      });
      await expect(
        engine.invoke(
          capabilityId,
          { __generated_invalid: true },
          { principal: null },
        ),
      ).rejects.toMatchObject({ code: "INPUT_INVALID" });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it.each(${json(successCases)} as const)(
    "invokes $selector for declared status $status when a witness is proven",
    async ({ capabilityId, portName, input, output }) => {
      const invoke = vi.fn(async () => output);
      const engine = createOpenApiEngine({
        ports: fakePorts(portName as keyof OpenApiPorts, invoke),
      });

      const result = await engine.invoke(capabilityId, input, { principal: null });
      expect(result.status).toBe(output.status);
      expect(Object.hasOwn(result, "body")).toBe(Object.hasOwn(output, "body"));
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );
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
  let directInput = "<valid JSON object>";
  try {
    directInput = JSON.stringify(sampleJsonSchema(first.inputSchema));
  } catch {
    // Keep an explicit placeholder when no bounded witness can be proven.
  }
  const quotedDirectInput = `'${directInput.replaceAll("'", `'"'"'`)}'`;
  return contents
    .replace(
      "with one\ndeterministic capability",
      `with ${String(operations.length)} generated OpenAPI capabilities`,
    )
    .replaceAll("onboarding.create-welcome-message", first.capabilityId)
    .replace("npm run direct -- Ada", `npm run direct -- ${quotedDirectInput}`)
    .replace('--input \'{"name":"Ada"}\'', `--input ${quotedDirectInput}`);
}

const reviewInstruction =
  "Review every generated capability's domain meaning and access rule before deployment.";

function appendReviewInstruction(contents: string): string {
  return `${contents.trimEnd()}\n\n${reviewInstruction}\n`;
}

function adaptMcpHttpModule(contents: string): string {
  return contents
    .replace(
      '} from "./env.js";\n',
      '} from "./env.js";\nimport { reportConnectorConfigurationFailure } from "./openapi/startup.js";\n',
    )
    .replace(
      "  reportStartupFailure(error);",
      "  if (!reportConnectorConfigurationFailure(error)) {\n    reportStartupFailure(error);\n  }",
    );
}

interface EnvironmentInstruction {
  readonly name: string;
  readonly instructions: readonly string[];
}

function environmentInstructions(
  operations: readonly OpenApiStarterOperation[],
): readonly EnvironmentInstruction[] {
  const instructions = new Map<string, Set<string>>();
  const add = (name: string, instruction: string): void => {
    const current = instructions.get(name) ?? new Set<string>();
    current.add(instruction);
    instructions.set(name, current);
  };
  for (const operation of operations) {
    const baseUrl = operationBaseUrl(operation);
    add(
      baseUrl.environmentVariable,
      `${baseUrl.default === undefined ? "Required base URL" : "Optional base URL override"} for \`${operation.capabilityId}\`.`,
    );
    const alternatives = operation.security.alternatives;
    const hasAnonymous = alternatives.some(
      (alternative) => alternative.length === 0,
    );
    for (const alternative of alternatives) {
      for (const scheme of alternative) {
        const kind =
          scheme.type === "basic"
            ? "Basic credential"
            : scheme.type === "bearer"
              ? "Bearer token"
              : "API key";
        for (const name of Object.values(scheme.environmentVariables)) {
          if (name === undefined) continue;
          add(
            name,
            `${alternatives.length === 1 && !hasAnonymous ? "Required" : "Credential alternative"} ${kind.toLowerCase()} for \`${operation.capabilityId}\`.`,
          );
        }
      }
    }
  }
  return Object.freeze(
    [...instructions]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, values]) =>
        Object.freeze({
          name,
          instructions: Object.freeze([...values].sort()),
        }),
      ),
  );
}

function renderUpstreamEnvironmentExample(
  instructions: readonly EnvironmentInstruction[],
): string {
  return `${instructions
    .map(
      ({ name, instructions: details }) =>
        `${details.map((detail) => `# ${detail.replaceAll("`", "")}`).join("\n")}\n${name}=`,
    )
    .join("\n\n")}\n`;
}

function appendUpstreamConfiguration(
  contents: string,
  instructions: readonly EnvironmentInstruction[],
): string {
  const rows = instructions
    .map(
      ({ name, instructions: details }) =>
        `| \`${name}\` | ${details.join(" ")} |`,
    )
    .join("\n");
  return `${contents.trimEnd()}\n\n## Configure the upstream API\n\nSet only the variables required by the capabilities you keep. Copy\n\`upstream.env.example\` to your preferred secret-management workflow; never\ncommit credential values.\n\n| Variable | Purpose |\n| --- | --- |\n${rows}\n`;
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

function assertUniquePortableModuleNames(
  operations: readonly OpenApiStarterOperation[],
): void {
  const names = new Set<string>();
  for (const operation of operations) {
    if (names.has(operation.moduleName)) {
      throw new TypeError(
        "Selected OpenAPI operations contain a duplicate portable module name.",
      );
    }
    names.add(operation.moduleName);
  }
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
  assertUniquePortableModuleNames(operations);
  const envNames = environmentNames(operations);
  const upstreamInstructions = environmentInstructions(operations);
  const replacements = new Map<string, StarterEntry>();
  for (const entry of createStarterFiles(options)) {
    if (entry.path === "src/capabilities/create-welcome-message.ts") continue;
    if (entry.path === "src/engine.ts") {
      replacements.set(
        entry.path,
        generatedFile(entry.path, renderEngine(envNames)),
      );
      continue;
    }
    if (entry.path === "src/direct.ts") {
      replacements.set(
        entry.path,
        generatedFile(entry.path, renderDirect(first)),
      );
      continue;
    }
    if (entry.path === "src/cli.ts") {
      replacements.set(entry.path, generatedFile(entry.path, renderCli()));
      continue;
    }
    if (entry.path === "src/mcp-stdio.ts") {
      replacements.set(entry.path, generatedFile(entry.path, renderMcpStdio()));
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
          appendReviewInstruction(
            appendUpstreamConfiguration(
              adaptReadme(entry.contents, operations),
              upstreamInstructions,
            ),
          ),
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
    generatedFile(
      "src/openapi-engine.ts",
      renderOpenApiEngine(options.projectName, operations),
    ),
    generatedFile(
      "src/openapi/connector.ts",
      renderFetchConnector(operations, envNames),
    ),
    generatedFile("src/openapi/ports.ts", renderPorts(operations)),
    generatedFile("src/openapi/startup.ts", renderStartupModule()),
    generatedFile(
      "upstream.env.example",
      renderUpstreamEnvironmentExample(upstreamInstructions),
    ),
  ]) {
    replacements.set(entry.path, entry);
  }
  const entries = [...replacements.values()].sort(compareEntries);
  return Object.freeze(entries);
}
