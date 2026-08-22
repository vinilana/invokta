import { createHash } from "node:crypto";

import {
  containsUnsupportedOpenApiReference,
  type OpenApiDocument,
  OpenApiImportError,
  type OpenApiObject,
} from "./openapi.js";

const httpMethods = Object.freeze([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const);

type HttpMethod = Uppercase<(typeof httpMethods)[number]>;

export type OpenApiIneligibilityReason =
  | "REFERENCE_UNSUPPORTED"
  | "SERVER_UNSUPPORTED"
  | "SECURITY_UNSUPPORTED"
  | "PARAMETER_UNSUPPORTED"
  | "REQUEST_BODY_UNSUPPORTED"
  | "SUCCESS_RESPONSE_MISSING"
  | "RESPONSE_UNSUPPORTED"
  | "SCHEMA_UNSUPPORTED"
  | "CAPABILITY_ID_COLLISION"
  | "MCP_TOOL_NAME_COLLISION";

export type OpenApiEligibility =
  | Readonly<{ eligible: true }>
  | Readonly<{
      eligible: false;
      reason: OpenApiIneligibilityReason;
    }>;

export interface OpenApiConnectionPlan {
  readonly serverSource: "operation" | "path" | "root" | "default";
  readonly serverUrls: readonly string[];
}

export interface OpenApiOperationCandidate {
  readonly method: HttpMethod;
  readonly path: string;
  readonly selector: string;
  readonly operationId?: string;
  readonly connection: OpenApiConnectionPlan;
  readonly eligibility: OpenApiEligibility;
}

type JsonSchema = boolean | OpenApiObject;

export interface OpenApiStarterParameter {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly style: string;
  readonly explode: boolean;
  readonly schema: JsonSchema;
}

export interface OpenApiStarterRequestBody {
  readonly required: boolean;
  readonly mediaType: "application/json";
  readonly schema: JsonSchema;
}

export interface OpenApiStarterSuccessResponse {
  readonly status: string;
  readonly mediaType: string | undefined;
  readonly schema: JsonSchema | undefined;
}

export interface OpenApiStarterSecurityScheme {
  readonly name: string;
  readonly type: "apiKey" | "basic" | "bearer";
  readonly in?: "header" | "query" | "cookie";
  readonly parameterName?: string;
  readonly environmentVariables: Readonly<
    Partial<Record<"value" | "username" | "password" | "token", string>>
  >;
}

export interface OpenApiStarterOperationPlan {
  readonly selector: string;
  readonly operationId?: string;
  readonly capabilityId: string;
  readonly exportName: string;
  readonly moduleName: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly connection: Readonly<{
    serverSource: OpenApiConnectionPlan["serverSource"];
    serverUrls: readonly string[];
    baseUrl: Readonly<{
      environmentVariable: string;
      default?: string;
    }>;
  }>;
  readonly inputSchema: OpenApiObject;
  readonly outputSchema: OpenApiObject;
  readonly parameters: readonly OpenApiStarterParameter[];
  readonly requestBody: OpenApiStarterRequestBody | undefined;
  readonly successResponses: readonly OpenApiStarterSuccessResponse[];
  readonly security: Readonly<{
    alternatives: readonly (readonly OpenApiStarterSecurityScheme[])[];
  }>;
}

function asObject(value: unknown): OpenApiObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as OpenApiObject;
}

function hasOwn(record: OpenApiObject, key: string): boolean {
  return Object.hasOwn(record, key);
}

function supportedParameterScalarSchema(value: unknown): boolean {
  if (value === false) return true;
  if (value === true) return false;
  const schema = asObject(value);
  if (schema === undefined) return false;
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every(
      (member) =>
        typeof member === "string" ||
        (typeof member === "number" && Number.isFinite(member)) ||
        typeof member === "boolean",
    )
  ) {
    return true;
  }
  if (
    typeof schema.const === "string" ||
    (typeof schema.const === "number" && Number.isFinite(schema.const)) ||
    typeof schema.const === "boolean"
  ) {
    return true;
  }
  return (
    schema.type === "string" ||
    schema.type === "number" ||
    schema.type === "integer" ||
    schema.type === "boolean"
  );
}

function supportedParameterSchema(
  schemaValue: unknown,
  location: string,
  style: string,
): boolean {
  if (supportedParameterScalarSchema(schemaValue)) return true;
  const schema = asObject(schemaValue);
  if (schema === undefined) return false;
  if (schema.type === "array")
    return supportedParameterScalarSchema(schema.items);
  if (
    location !== "query" ||
    style !== "deepObject" ||
    schema.type !== "object"
  ) {
    return false;
  }
  const properties = asObject(schema.properties);
  if (
    properties !== undefined &&
    !Object.values(properties).every(supportedParameterScalarSchema)
  ) {
    return false;
  }
  if (!hasOwn(schema, "additionalProperties")) return false;
  return (
    schema.additionalProperties === false ||
    supportedParameterScalarSchema(schema.additionalProperties)
  );
}

function parameterSupported(value: unknown): boolean {
  const parameter = asObject(value);
  if (parameter === undefined || typeof parameter.name !== "string")
    return false;
  if (parameter.$ref !== undefined || parameter.content !== undefined)
    return false;
  if (parameter.allowReserved === true) return false;
  const location = parameter.in;
  if (
    location !== "path" &&
    location !== "query" &&
    location !== "header" &&
    location !== "cookie"
  ) {
    return false;
  }
  if (
    location === "header" &&
    ["accept", "content-type", "authorization"].includes(
      parameter.name.toLowerCase(),
    )
  ) {
    return true;
  }
  if (location === "path" && parameter.required !== true) return false;
  const defaultStyle =
    location === "query" || location === "cookie" ? "form" : "simple";
  const style =
    typeof parameter.style === "string" ? parameter.style : defaultStyle;
  if (
    (location === "path" && style !== "simple") ||
    (location === "header" && style !== "simple") ||
    (location === "cookie" && style !== "form") ||
    (location === "query" && style !== "form" && style !== "deepObject")
  ) {
    return false;
  }
  if (
    style === "deepObject" &&
    parameter.explode !== undefined &&
    parameter.explode !== true
  ) {
    return false;
  }
  return supportedParameterSchema(parameter.schema, location, style);
}

function effectiveParameters(
  pathItem: OpenApiObject,
  operation: OpenApiObject,
): readonly unknown[] | undefined {
  const effective = new Map<string, unknown>();
  for (const value of [pathItem.parameters, operation.parameters]) {
    if (value === undefined) continue;
    if (!Array.isArray(value)) return undefined;
    const declared = new Set<string>();
    for (const parameterValue of value) {
      const parameter = asObject(parameterValue);
      if (
        parameter === undefined ||
        typeof parameter.name !== "string" ||
        typeof parameter.in !== "string"
      ) {
        return undefined;
      }
      const key = `${parameter.in}\u0000${parameter.name}`;
      if (declared.has(key)) return undefined;
      declared.add(key);
      effective.set(key, parameterValue);
    }
  }
  return Object.freeze([...effective.values()]);
}

function parametersSupported(
  pathItem: OpenApiObject,
  operation: OpenApiObject,
): boolean {
  const parameters = effectiveParameters(pathItem, operation);
  return parameters?.every(parameterSupported) ?? false;
}

function requestBodySupported(operation: OpenApiObject): boolean {
  if (operation.requestBody === undefined) return true;
  const requestBody = asObject(operation.requestBody);
  if (requestBody === undefined || requestBody.$ref !== undefined) return false;
  const content = asObject(requestBody.content);
  return (
    content !== undefined && asObject(content["application/json"]) !== undefined
  );
}

function hasExplicitSuccessResponse(operation: OpenApiObject): boolean {
  const responses = asObject(operation.responses);
  if (responses === undefined) return false;
  return Object.keys(responses).some(
    (status) =>
      status === "2XX" ||
      /^(?:20\d|21\d|22\d|23\d|24\d|25\d|26\d|27\d|28\d|29\d)$/u.test(status),
  );
}

interface SupportedResponseMedia {
  readonly supported: boolean;
  readonly schema?: unknown;
}

function supportedResponseMedia(
  response: OpenApiObject,
): SupportedResponseMedia {
  if (response.content === undefined) return { supported: true };
  const content = asObject(response.content);
  if (content === undefined) return { supported: false };
  const mediaTypes = Object.keys(content);
  if (mediaTypes.length === 0) return { supported: true };

  if (hasOwn(content, "application/json")) {
    const media = asObject(content["application/json"]);
    return media === undefined
      ? { supported: false }
      : { supported: true, schema: media.schema };
  }
  const suffixJsonMediaTypes = mediaTypes.filter((name) =>
    /^application\/[A-Za-z\d!#$&^_.+-]+\+json$/u.test(name),
  );
  if (suffixJsonMediaTypes.length !== 1) return { supported: false };
  const media = asObject(content[suffixJsonMediaTypes[0] as string]);
  return media === undefined
    ? { supported: false }
    : { supported: true, schema: media.schema };
}

function successResponsesSupported(operation: OpenApiObject): boolean {
  const responses = asObject(operation.responses);
  if (responses === undefined) return false;
  for (const [status, responseValue] of Object.entries(responses)) {
    if (status !== "2XX" && !/^2\d\d$/u.test(status)) continue;
    const response = asObject(responseValue);
    if (response === undefined || !supportedResponseMedia(response).supported) {
      return false;
    }
  }
  return true;
}

const supportedSchemaKeywords = new Set([
  "$comment",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "deprecated",
  "description",
  "enum",
  "example",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "multipleOf",
  "oneOf",
  "pattern",
  "prefixItems",
  "properties",
  "readOnly",
  "required",
  "title",
  "type",
  "writeOnly",
]);

interface SchemaCheckState {
  count: number;
}

function isLosslessJson(
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.every((member) => isLosslessJson(member, nextAncestors));
  }
  const object = asObject(value);
  return (
    object !== undefined &&
    Object.values(object).every((member) =>
      isLosslessJson(member, nextAncestors),
    )
  );
}

function validSchemaScalarFields(schema: OpenApiObject): boolean {
  const allowedTypes = new Set([
    "array",
    "boolean",
    "integer",
    "null",
    "number",
    "object",
    "string",
  ]);
  if (
    schema.type !== undefined &&
    !(
      (typeof schema.type === "string" && allowedTypes.has(schema.type)) ||
      (Array.isArray(schema.type) &&
        schema.type.length > 0 &&
        schema.type.every(
          (value, index, values) =>
            typeof value === "string" &&
            allowedTypes.has(value) &&
            values.indexOf(value) === index,
        ))
    )
  ) {
    return false;
  }
  if (
    Object.keys(schema).some(
      (name) => !supportedSchemaKeywords.has(name) && !name.startsWith("x-"),
    )
  ) {
    return false;
  }
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      !schema.enum.every((member) => isLosslessJson(member)))
  ) {
    return false;
  }
  if (hasOwn(schema, "const") && !isLosslessJson(schema.const)) return false;
  if (hasOwn(schema, "default") && !isLosslessJson(schema.default)) {
    return false;
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      !schema.required.every(
        (value, index, values) =>
          typeof value === "string" && values.indexOf(value) === index,
      ))
  ) {
    return false;
  }
  for (const name of ["minLength", "maxLength", "minItems", "maxItems"]) {
    const value = schema[name];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || (value as number) < 0)
    ) {
      return false;
    }
  }
  for (const name of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ]) {
    const value = schema[name];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      return false;
    }
  }
  if (schema.multipleOf !== undefined && (schema.multipleOf as number) <= 0) {
    return false;
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") return false;
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      return false;
    }
  }
  return true;
}

function schemaSupported(value: unknown, state: SchemaCheckState): boolean {
  if (typeof value === "boolean") {
    state.count += 1;
    return state.count <= 1_000;
  }
  const schema = asObject(value);
  if (schema === undefined) return false;
  state.count += 1;
  if (state.count > 1_000) return false;
  if (!validSchemaScalarFields(schema)) {
    return false;
  }

  const properties = schema.properties;
  if (properties !== undefined) {
    const propertyMap = asObject(properties);
    if (
      propertyMap === undefined ||
      !Object.values(propertyMap).every((member) =>
        schemaSupported(member, state),
      )
    ) {
      return false;
    }
  }
  if (
    schema.additionalProperties !== undefined &&
    !schemaSupported(schema.additionalProperties, state)
  ) {
    return false;
  }
  if (schema.items !== undefined && !schemaSupported(schema.items, state)) {
    return false;
  }
  if (schema.prefixItems !== undefined) {
    if (
      !Array.isArray(schema.prefixItems) ||
      !schema.prefixItems.every((member) => schemaSupported(member, state))
    ) {
      return false;
    }
  }
  for (const name of ["anyOf", "oneOf", "allOf"]) {
    const members = schema[name];
    if (
      members !== undefined &&
      (!Array.isArray(members) ||
        members.length === 0 ||
        !members.every((member) => schemaSupported(member, state)))
    ) {
      return false;
    }
  }
  return true;
}

function operationSchemasSupported(
  pathItem: OpenApiObject,
  operation: OpenApiObject,
): boolean {
  const roots: unknown[] = [];
  for (const value of effectiveParameters(pathItem, operation) ?? []) {
    const parameter = asObject(value);
    if (
      parameter?.in === "header" &&
      typeof parameter.name === "string" &&
      ["accept", "content-type", "authorization"].includes(
        parameter.name.toLowerCase(),
      )
    ) {
      continue;
    }
    roots.push(parameter?.schema);
  }
  if (operation.requestBody !== undefined) {
    const requestBody = asObject(operation.requestBody);
    const media = asObject(
      asObject(requestBody?.content)?.["application/json"],
    );
    if (media?.schema !== undefined) roots.push(media.schema);
  }
  const responses = asObject(operation.responses);
  for (const [status, responseValue] of Object.entries(responses ?? {})) {
    if (status !== "2XX" && !/^2\d\d$/u.test(status)) continue;
    const response = asObject(responseValue);
    if (response === undefined) continue;
    const media = supportedResponseMedia(response);
    if (media.schema !== undefined) roots.push(media.schema);
  }

  const state: SchemaCheckState = { count: 0 };
  return roots.every((schema) => schemaSupported(schema, state));
}

function supportedSecurityScheme(value: unknown): boolean {
  const scheme = asObject(value);
  if (scheme === undefined || scheme.$ref !== undefined) return false;
  if (scheme.type === "apiKey") {
    return (
      typeof scheme.name === "string" &&
      scheme.name !== "" &&
      (scheme.in === "header" ||
        scheme.in === "query" ||
        scheme.in === "cookie")
    );
  }
  return (
    scheme.type === "http" &&
    typeof scheme.scheme === "string" &&
    (scheme.scheme.toLowerCase() === "basic" ||
      scheme.scheme.toLowerCase() === "bearer")
  );
}

function securitySupported(
  document: OpenApiDocument,
  operation: OpenApiObject,
): boolean {
  const requirements = hasOwn(operation, "security")
    ? operation.security
    : document.security;
  if (requirements === undefined) return true;
  if (!Array.isArray(requirements)) return false;
  const schemes = asObject(asObject(document.components)?.securitySchemes);
  return requirements.every((requirementValue) => {
    const requirement = asObject(requirementValue);
    if (requirement === undefined) return false;
    const destinations = new Set<string>();
    return Object.entries(requirement).every(([name, scopes]) => {
      const scheme = asObject(schemes?.[name]);
      if (
        !Array.isArray(scopes) ||
        scopes.length !== 0 ||
        !supportedSecurityScheme(scheme)
      ) {
        return false;
      }
      const destination =
        scheme?.type === "http"
          ? "header:authorization"
          : `${String(scheme?.in)}:${
              scheme?.in === "header"
                ? String(scheme.name).toLowerCase()
                : String(scheme?.name)
            }`;
      if (destinations.has(destination)) return false;
      destinations.add(destination);
      return true;
    });
  });
}

function referencesSupported(
  document: OpenApiDocument,
  pathItem: OpenApiObject,
  operation: OpenApiObject,
): boolean {
  if (
    containsUnsupportedOpenApiReference(operation) ||
    containsUnsupportedOpenApiReference(pathItem.parameters)
  ) {
    return false;
  }

  const effectiveServers = hasOwn(operation, "servers")
    ? operation.servers
    : hasOwn(pathItem, "servers")
      ? pathItem.servers
      : document.servers;
  if (containsUnsupportedOpenApiReference(effectiveServers)) return false;

  const requirements = hasOwn(operation, "security")
    ? operation.security
    : document.security;
  if (containsUnsupportedOpenApiReference(requirements)) return false;
  if (!Array.isArray(requirements)) return true;

  const schemes = asObject(asObject(document.components)?.securitySchemes);
  for (const requirementValue of requirements) {
    const requirement = asObject(requirementValue);
    if (requirement === undefined) continue;
    for (const name of Object.keys(requirement)) {
      if (containsUnsupportedOpenApiReference(schemes?.[name])) return false;
    }
  }
  return true;
}

function expandSupportedServerUrl(serverValue: unknown): string | undefined {
  const server = asObject(serverValue);
  if (
    server === undefined ||
    typeof server.url !== "string" ||
    server.url === ""
  ) {
    return undefined;
  }
  const variables = asObject(server.variables);
  let complete = true;
  const expanded = server.url.replace(
    /\{([^{}]+)\}/gu,
    (_match, name: string) => {
      const variable = asObject(variables?.[name]);
      if (variable === undefined || typeof variable.default !== "string") {
        complete = false;
        return "";
      }
      return variable.default;
    },
  );
  if (!complete || /[{}]/u.test(expanded)) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(expanded);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return undefined;
  }
  return expanded;
}

function readServers(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const urls: string[] = [];
  for (const serverValue of value) {
    const url = expandSupportedServerUrl(serverValue);
    if (url === undefined) return undefined;
    urls.push(url);
  }
  return Object.freeze(urls);
}

function connectionFor(
  document: OpenApiDocument,
  pathItem: OpenApiObject,
  operation: OpenApiObject,
): OpenApiConnectionPlan {
  if (hasOwn(operation, "servers")) {
    return Object.freeze({
      serverSource: "operation",
      serverUrls: readServers(operation.servers) ?? Object.freeze([]),
    });
  }
  if (hasOwn(pathItem, "servers")) {
    return Object.freeze({
      serverSource: "path",
      serverUrls: readServers(pathItem.servers) ?? Object.freeze([]),
    });
  }
  if (hasOwn(document, "servers")) {
    return Object.freeze({
      serverSource: "root",
      serverUrls: readServers(document.servers) ?? Object.freeze([]),
    });
  }
  return Object.freeze({
    serverSource: "default",
    serverUrls: Object.freeze([]),
  });
}

function eligibilityFor(
  document: OpenApiDocument,
  pathItem: OpenApiObject,
  operation: OpenApiObject,
  connection: OpenApiConnectionPlan,
): OpenApiEligibility {
  if (!referencesSupported(document, pathItem, operation)) {
    return Object.freeze({
      eligible: false,
      reason: "REFERENCE_UNSUPPORTED",
    });
  }
  if (
    connection.serverSource !== "default" &&
    connection.serverUrls.length === 0
  ) {
    return Object.freeze({ eligible: false, reason: "SERVER_UNSUPPORTED" });
  }
  if (!securitySupported(document, operation)) {
    return Object.freeze({ eligible: false, reason: "SECURITY_UNSUPPORTED" });
  }
  if (!parametersSupported(pathItem, operation)) {
    return Object.freeze({ eligible: false, reason: "PARAMETER_UNSUPPORTED" });
  }
  if (!requestBodySupported(operation)) {
    return Object.freeze({
      eligible: false,
      reason: "REQUEST_BODY_UNSUPPORTED",
    });
  }
  if (!hasExplicitSuccessResponse(operation)) {
    return Object.freeze({
      eligible: false,
      reason: "SUCCESS_RESPONSE_MISSING",
    });
  }
  if (!successResponsesSupported(operation)) {
    return Object.freeze({ eligible: false, reason: "RESPONSE_UNSUPPORTED" });
  }
  if (!operationSchemasSupported(pathItem, operation)) {
    return Object.freeze({ eligible: false, reason: "SCHEMA_UNSUPPORTED" });
  }
  return Object.freeze({ eligible: true });
}

/** Discovers standard path operations in deterministic canonical-selector order. */
export function discoverOpenApiOperations(
  document: OpenApiDocument,
): readonly OpenApiOperationCandidate[] {
  const candidates: OpenApiOperationCandidate[] = [];
  for (const [path, pathItemValue] of Object.entries(document.paths)) {
    const pathItem = asObject(pathItemValue);
    if (pathItem === undefined) continue;
    for (const methodName of httpMethods) {
      const operation = asObject(pathItem[methodName]);
      if (operation === undefined) continue;
      const method = methodName.toUpperCase() as HttpMethod;
      const connection = connectionFor(document, pathItem, operation);
      const operationId =
        typeof operation.operationId === "string" &&
        operation.operationId !== ""
          ? operation.operationId
          : undefined;
      candidates.push(
        Object.freeze({
          method,
          path,
          selector: `${method}:${path}`,
          ...(operationId === undefined ? {} : { operationId }),
          connection,
          eligibility: eligibilityFor(
            document,
            pathItem,
            operation,
            connection,
          ),
        }),
      );
    }
  }
  if (candidates.length > 500) {
    throw new OpenApiImportError("OPENAPI_LIMIT_EXCEEDED");
  }
  candidates.sort((left, right) => {
    if (left.selector < right.selector) return -1;
    if (left.selector > right.selector) return 1;
    return 0;
  });
  const classifiedCandidates = markGeneratedNameCollisions(candidates);
  const eligibleCount = classifiedCandidates.filter(
    (candidate) => candidate.eligibility.eligible,
  ).length;
  if (eligibleCount > 100) {
    throw new OpenApiImportError("OPENAPI_LIMIT_EXCEEDED");
  }
  return classifiedCandidates;
}

/** Selects all eligible operations except deterministic selector exclusions. */
export function selectOpenApiOperations(
  candidates: readonly OpenApiOperationCandidate[],
  exclusions: readonly string[],
): readonly OpenApiOperationCandidate[] {
  const canonical = new Map(
    candidates.map((candidate) => [candidate.selector, candidate] as const),
  );
  const aliases = new Map<string, OpenApiOperationCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.operationId === undefined) continue;
    const group = aliases.get(candidate.operationId) ?? [];
    group.push(candidate);
    aliases.set(candidate.operationId, group);
  }

  const excluded = new Set<string>();
  for (const exclusion of exclusions) {
    const direct = canonical.get(exclusion);
    const aliasMatches = aliases.get(exclusion);
    const aliasIsAmbiguous =
      aliasMatches !== undefined &&
      (aliasMatches.length > 1 ||
        (direct !== undefined &&
          aliasMatches.length === 1 &&
          aliasMatches[0] !== direct));
    const resolved =
      direct ?? (aliasMatches?.length === 1 ? aliasMatches[0] : undefined);
    if (
      resolved === undefined ||
      aliasIsAmbiguous ||
      !resolved.eligibility.eligible
    ) {
      throw new OpenApiImportError("OPENAPI_SELECTION_INVALID");
    }
    excluded.add(resolved.selector);
  }

  const selected = candidates.filter(
    (candidate) =>
      candidate.eligibility.eligible && !excluded.has(candidate.selector),
  );
  if (selected.length === 0) {
    throw new OpenApiImportError("OPENAPI_SELECTION_INVALID");
  }
  return Object.freeze(selected);
}

function words(value: string): readonly string[] {
  const normalized = value
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/[^A-Za-z\d]+/gu, " ")
    .trim();
  if (normalized === "") return Object.freeze([]);
  return Object.freeze(
    normalized.split(/\s+/u).map((word) => word.toLowerCase()),
  );
}

function upperFirst(value: string): string {
  return value === "" ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function camelName(nameWords: readonly string[]): string {
  const [first = "operation", ...rest] = nameWords;
  const candidate = `${first}${rest.map(upperFirst).join("")}`;
  return /^[A-Za-z_$][A-Za-z\d_$]*$/u.test(candidate) &&
    !reservedBindingNames.has(candidate)
    ? candidate
    : `operation${upperFirst(candidate)}`;
}

const reservedBindingNames = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function operationNameWords(
  candidate: OpenApiOperationCandidate,
  useOperationId: boolean,
): readonly string[] {
  if (useOperationId && candidate.operationId !== undefined) {
    const operationIdWords = words(candidate.operationId);
    if (operationIdWords.length > 0) return operationIdWords;
  }
  const pathWords = words(candidate.path.replace(/[{}]/gu, " "));
  return Object.freeze([candidate.method.toLowerCase(), ...pathWords]);
}

const windowsReservedBasenames = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const maxModuleNameLength = 64;

function moduleNameForWords(nameWords: readonly string[]): string {
  const raw = nameWords.join("-") || "operation";
  if (windowsReservedBasenames.test(raw)) return `_${raw}`;
  if (raw.length <= maxModuleNameLength) return raw;
  const hash = createHash("sha256")
    .update(raw, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${raw.slice(0, maxModuleNameLength - hash.length - 1)}-${hash}`;
}

function operationIdCounts(
  candidates: readonly OpenApiOperationCandidate[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.operationId === undefined) continue;
    counts.set(
      candidate.operationId,
      (counts.get(candidate.operationId) ?? 0) + 1,
    );
  }
  return counts;
}

function capabilityIdForCandidate(
  candidate: OpenApiOperationCandidate,
  operationIds: ReadonlyMap<string, number>,
): string {
  const nameWords = operationNameWords(
    candidate,
    candidate.operationId !== undefined &&
      operationIds.get(candidate.operationId) === 1,
  );
  return `openapi.${nameWords.join("-")}`;
}

function mcpToolName(capabilityId: string): string {
  const portable = capabilityId.replace(/[^a-zA-Z0-9_-]/gu, "_") || "_";
  if (portable.length <= 64) return portable;
  const hash = createHash("sha256")
    .update(capabilityId, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${portable.slice(0, 51)}_${hash}`;
}

function markGeneratedNameCollisions(
  candidates: readonly OpenApiOperationCandidate[],
): readonly OpenApiOperationCandidate[] {
  const operationIds = operationIdCounts(candidates);
  const capabilityGroups = new Map<string, number[]>();
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate.eligibility.eligible) continue;
    const capabilityId = capabilityIdForCandidate(candidate, operationIds);
    const group = capabilityGroups.get(capabilityId) ?? [];
    group.push(index);
    capabilityGroups.set(capabilityId, group);
  }

  const capabilityCollisionIndexes = new Set<number>();
  for (const group of capabilityGroups.values()) {
    if (group.length > 1) {
      for (const index of group) capabilityCollisionIndexes.add(index);
    }
  }
  const mcpGroups = new Map<string, number[]>();
  for (const [index, candidate] of candidates.entries()) {
    if (
      !candidate.eligibility.eligible ||
      capabilityCollisionIndexes.has(index)
    ) {
      continue;
    }
    const capabilityId = capabilityIdForCandidate(candidate, operationIds);
    const toolName = mcpToolName(capabilityId);
    const group = mcpGroups.get(toolName) ?? [];
    group.push(index);
    mcpGroups.set(toolName, group);
  }
  const mcpCollisionIndexes = new Set<number>();
  for (const group of mcpGroups.values()) {
    if (group.length > 1) {
      for (const index of group) mcpCollisionIndexes.add(index);
    }
  }

  return Object.freeze(
    candidates.map((candidate, index) => {
      const reason = capabilityCollisionIndexes.has(index)
        ? "CAPABILITY_ID_COLLISION"
        : mcpCollisionIndexes.has(index)
          ? "MCP_TOOL_NAME_COLLISION"
          : undefined;
      return reason === undefined
        ? candidate
        : Object.freeze({
            ...candidate,
            eligibility: Object.freeze({ eligible: false, reason }),
          });
    }),
  );
}

function environmentStem(value: string): string {
  const nameWords = words(value);
  return nameWords.length === 0 ? "VALUE" : nameWords.join("_").toUpperCase();
}

function operationObjects(
  document: OpenApiDocument,
  candidate: OpenApiOperationCandidate,
): Readonly<{ pathItem: OpenApiObject; operation: OpenApiObject }> {
  const pathItem = asObject(document.paths[candidate.path]);
  const operation = asObject(pathItem?.[candidate.method.toLowerCase()]);
  if (pathItem === undefined || operation === undefined) {
    throw new OpenApiImportError("OPENAPI_INVALID");
  }
  return Object.freeze({ pathItem, operation });
}

function effectiveServerValues(
  document: OpenApiDocument,
  pathItem: OpenApiObject,
  operation: OpenApiObject,
): readonly unknown[] {
  const value = hasOwn(operation, "servers")
    ? operation.servers
    : hasOwn(pathItem, "servers")
      ? pathItem.servers
      : document.servers;
  return Array.isArray(value) ? value : Object.freeze([]);
}

function starterParameters(
  pathItem: OpenApiObject,
  operation: OpenApiObject,
): readonly OpenApiStarterParameter[] {
  const normalized: OpenApiStarterParameter[] = [];
  for (const value of effectiveParameters(pathItem, operation) ?? []) {
    const parameter = asObject(value);
    if (
      parameter === undefined ||
      typeof parameter.name !== "string" ||
      (parameter.in !== "path" &&
        parameter.in !== "query" &&
        parameter.in !== "header" &&
        parameter.in !== "cookie") ||
      (typeof parameter.schema !== "boolean" &&
        asObject(parameter.schema) === undefined)
    ) {
      throw new OpenApiImportError("OPENAPI_UNSUPPORTED");
    }
    if (
      parameter.in === "header" &&
      ["accept", "content-type", "authorization"].includes(
        parameter.name.toLowerCase(),
      )
    ) {
      continue;
    }
    const style =
      typeof parameter.style === "string"
        ? parameter.style
        : parameter.in === "query" || parameter.in === "cookie"
          ? "form"
          : "simple";
    const defaultExplode = style === "form" || style === "deepObject";
    normalized.push(
      Object.freeze({
        name: parameter.name,
        in: parameter.in,
        required: parameter.required === true,
        style,
        explode:
          typeof parameter.explode === "boolean"
            ? parameter.explode
            : defaultExplode,
        schema: parameter.schema as JsonSchema,
      }),
    );
  }
  return Object.freeze(normalized);
}

function starterRequestBody(
  operation: OpenApiObject,
): OpenApiStarterRequestBody | undefined {
  if (operation.requestBody === undefined) return undefined;
  const requestBody = asObject(operation.requestBody);
  const media = asObject(asObject(requestBody?.content)?.["application/json"]);
  if (requestBody === undefined || media === undefined) {
    throw new OpenApiImportError("OPENAPI_UNSUPPORTED");
  }
  const schema =
    typeof media.schema === "boolean" || asObject(media.schema) !== undefined
      ? (media.schema as JsonSchema)
      : Object.freeze({});
  return Object.freeze({
    required: requestBody.required === true,
    mediaType: "application/json",
    schema,
  });
}

function inputSchemaFor(
  parameters: readonly OpenApiStarterParameter[],
  requestBody: OpenApiStarterRequestBody | undefined,
): OpenApiObject {
  const properties: Record<string, unknown> = {};
  const requiredGroups: string[] = [];
  const groups = [
    ["path", "path"],
    ["query", "query"],
    ["headers", "header"],
    ["cookies", "cookie"],
  ] as const;
  for (const [publicName, location] of groups) {
    const members = parameters.filter((parameter) => parameter.in === location);
    if (members.length === 0) continue;
    const memberProperties = Object.fromEntries(
      members.map((parameter) => [parameter.name, parameter.schema]),
    );
    const requiredMembers = members
      .filter((parameter) => parameter.required)
      .map((parameter) => parameter.name);
    properties[publicName] = Object.freeze({
      type: "object",
      properties: Object.freeze(memberProperties),
      ...(requiredMembers.length === 0
        ? {}
        : { required: Object.freeze(requiredMembers) }),
      additionalProperties: false,
    });
    if (requiredMembers.length > 0) requiredGroups.push(publicName);
  }
  if (requestBody !== undefined) {
    properties.body = requestBody.schema;
    if (requestBody.required) requiredGroups.push("body");
  }
  return Object.freeze({
    type: "object",
    properties: Object.freeze(properties),
    ...(requiredGroups.length === 0
      ? {}
      : { required: Object.freeze(requiredGroups) }),
    additionalProperties: false,
  });
}

function responseMedia(
  response: OpenApiObject,
): Readonly<{ mediaType: string; schema: JsonSchema }> | undefined {
  const content = asObject(response.content);
  if (content === undefined || Object.keys(content).length === 0)
    return undefined;
  const mediaType =
    asObject(content["application/json"]) !== undefined
      ? "application/json"
      : Object.keys(content)
          .filter((name) =>
            /^application\/[A-Za-z\d!#$&^_.+-]+\+json$/u.test(name),
          )
          .sort()[0];
  if (mediaType === undefined) {
    throw new OpenApiImportError("OPENAPI_UNSUPPORTED");
  }
  const media = asObject(content[mediaType]);
  if (media === undefined) throw new OpenApiImportError("OPENAPI_UNSUPPORTED");
  const schema =
    typeof media.schema === "boolean" || asObject(media.schema) !== undefined
      ? (media.schema as JsonSchema)
      : Object.freeze({});
  return Object.freeze({ mediaType, schema });
}

function starterSuccessResponses(
  operation: OpenApiObject,
): readonly OpenApiStarterSuccessResponse[] {
  const responses = asObject(operation.responses);
  if (responses === undefined)
    throw new OpenApiImportError("OPENAPI_UNSUPPORTED");
  const planned: OpenApiStarterSuccessResponse[] = [];
  const entries = Object.entries(responses)
    .filter(([status]) => status === "2XX" || /^2\d\d$/u.test(status))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [status, responseValue] of entries) {
    const response = asObject(responseValue);
    if (response === undefined)
      throw new OpenApiImportError("OPENAPI_UNSUPPORTED");
    const media = responseMedia(response);
    planned.push(
      Object.freeze({
        status,
        mediaType: media?.mediaType,
        schema: media?.schema,
      }),
    );
  }
  return Object.freeze(planned);
}

function outputSchemaFor(
  responses: readonly OpenApiStarterSuccessResponse[],
): OpenApiObject {
  const variants = responses.map((response) => {
    const statusSchema =
      response.status === "2XX"
        ? Object.freeze({ type: "integer", minimum: 200, maximum: 299 })
        : Object.freeze({ const: Number(response.status) });
    const properties: Record<string, unknown> = { status: statusSchema };
    const required = ["status"];
    if (response.mediaType !== undefined) {
      properties.body = response.schema ?? Object.freeze({});
      required.push("body");
    }
    return Object.freeze({
      type: "object",
      properties: Object.freeze(properties),
      required: Object.freeze(required),
      additionalProperties: false,
    });
  });
  return variants.length === 1
    ? (variants[0] as OpenApiObject)
    : Object.freeze({ type: "object", oneOf: Object.freeze(variants) });
}

function securityEnvironmentStems(
  document: OpenApiDocument,
): ReadonlyMap<string, string> {
  const schemes = asObject(asObject(document.components)?.securitySchemes);
  const result = new Map<string, string>();
  const used = new Map<string, number>();
  for (const name of Object.keys(schemes ?? {}).sort()) {
    const base = environmentStem(name);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    result.set(name, count === 1 ? base : `${base}_${count}`);
  }
  return result;
}

function starterSecurity(
  document: OpenApiDocument,
  operation: OpenApiObject,
  stems: ReadonlyMap<string, string>,
): OpenApiStarterOperationPlan["security"] {
  const requirementValue = hasOwn(operation, "security")
    ? operation.security
    : document.security;
  if (requirementValue === undefined) {
    return Object.freeze({ alternatives: Object.freeze([Object.freeze([])]) });
  }
  if (!Array.isArray(requirementValue)) {
    throw new OpenApiImportError("OPENAPI_UNSUPPORTED");
  }
  if (requirementValue.length === 0) {
    return Object.freeze({ alternatives: Object.freeze([Object.freeze([])]) });
  }
  const schemes = asObject(asObject(document.components)?.securitySchemes);
  const alternatives = requirementValue.map((requirementValue) => {
    const requirement = asObject(requirementValue);
    if (requirement === undefined) {
      throw new OpenApiImportError("OPENAPI_UNSUPPORTED");
    }
    return Object.freeze(
      Object.keys(requirement)
        .sort()
        .map((name): OpenApiStarterSecurityScheme => {
          const scheme = asObject(schemes?.[name]);
          const stem = stems.get(name) ?? environmentStem(name);
          if (
            scheme?.type === "apiKey" &&
            (scheme.in === "header" ||
              scheme.in === "query" ||
              scheme.in === "cookie") &&
            typeof scheme.name === "string"
          ) {
            return Object.freeze({
              name,
              type: "apiKey",
              in: scheme.in,
              parameterName: scheme.name,
              environmentVariables: Object.freeze({
                value: `OPENAPI_${stem}_API_KEY`,
              }),
            });
          }
          if (
            scheme?.type === "http" &&
            typeof scheme.scheme === "string" &&
            scheme.scheme.toLowerCase() === "basic"
          ) {
            return Object.freeze({
              name,
              type: "basic",
              environmentVariables: Object.freeze({
                username: `OPENAPI_${stem}_USERNAME`,
                password: `OPENAPI_${stem}_PASSWORD`,
              }),
            });
          }
          if (
            scheme?.type === "http" &&
            typeof scheme.scheme === "string" &&
            scheme.scheme.toLowerCase() === "bearer"
          ) {
            return Object.freeze({
              name,
              type: "bearer",
              environmentVariables: Object.freeze({
                token: `OPENAPI_${stem}_TOKEN`,
              }),
            });
          }
          throw new OpenApiImportError("OPENAPI_UNSUPPORTED");
        }),
    );
  });
  return Object.freeze({ alternatives: Object.freeze(alternatives) });
}

/** Builds immutable, generator-ready plans for already-selected operations. */
export function buildOpenApiStarterOperations(
  document: OpenApiDocument,
  selectedCandidates: readonly OpenApiOperationCandidate[],
): readonly OpenApiStarterOperationPlan[] {
  const securityStems = securityEnvironmentStems(document);
  const operationIdCounts = new Map<string, number>();
  for (const pathItemValue of Object.values(document.paths)) {
    const pathItem = asObject(pathItemValue);
    if (pathItem === undefined) continue;
    for (const method of httpMethods) {
      const operation = asObject(pathItem[method]);
      if (
        operation === undefined ||
        typeof operation.operationId !== "string" ||
        operation.operationId === ""
      ) {
        continue;
      }
      operationIdCounts.set(
        operation.operationId,
        (operationIdCounts.get(operation.operationId) ?? 0) + 1,
      );
    }
  }
  const plans = selectedCandidates.map((candidate) => {
    if (!candidate.eligibility.eligible) {
      throw new OpenApiImportError("OPENAPI_SELECTION_INVALID");
    }
    const { pathItem, operation } = operationObjects(document, candidate);
    const nameWords = operationNameWords(
      candidate,
      candidate.operationId !== undefined &&
        operationIdCounts.get(candidate.operationId) === 1,
    );
    const moduleName = moduleNameForWords(nameWords);
    const exportName = camelName(words(moduleName));
    const serverUrls = effectiveServerValues(document, pathItem, operation)
      .map(expandSupportedServerUrl)
      .filter((value): value is string => value !== undefined);
    const parameters = starterParameters(pathItem, operation);
    const requestBody = starterRequestBody(operation);
    const successResponses = starterSuccessResponses(operation);
    const defaultBaseUrl = serverUrls.length === 1 ? serverUrls[0] : undefined;
    return Object.freeze({
      selector: candidate.selector,
      ...(candidate.operationId === undefined
        ? {}
        : { operationId: candidate.operationId }),
      capabilityId: `openapi.${moduleName}`,
      exportName,
      moduleName,
      method: candidate.method,
      path: candidate.path,
      title:
        typeof operation.summary === "string" && operation.summary !== ""
          ? operation.summary
          : `${candidate.method} ${candidate.path}`,
      description:
        typeof operation.description === "string" &&
        operation.description !== ""
          ? operation.description
          : typeof operation.summary === "string" && operation.summary !== ""
            ? operation.summary
            : `Calls ${candidate.method} ${candidate.path}.`,
      connection: Object.freeze({
        serverSource: candidate.connection.serverSource,
        serverUrls: Object.freeze(serverUrls),
        baseUrl: Object.freeze({
          environmentVariable: `OPENAPI_${environmentStem(exportName)}_BASE_URL`,
          ...(defaultBaseUrl === undefined ? {} : { default: defaultBaseUrl }),
        }),
      }),
      inputSchema: inputSchemaFor(parameters, requestBody),
      outputSchema: outputSchemaFor(successResponses),
      parameters,
      requestBody,
      successResponses,
      security: starterSecurity(document, operation, securityStems),
    });
  });
  return Object.freeze(plans);
}
