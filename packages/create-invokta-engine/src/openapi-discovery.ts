import {
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
  | "SERVER_UNSUPPORTED"
  | "PARAMETER_UNSUPPORTED"
  | "REQUEST_BODY_UNSUPPORTED"
  | "SUCCESS_RESPONSE_MISSING"
  | "SECURITY_UNSUPPORTED";

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

function asObject(value: unknown): OpenApiObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as OpenApiObject;
}

function hasOwn(record: OpenApiObject, key: string): boolean {
  return Object.hasOwn(record, key);
}

function supportedPrimitiveSchema(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  const schema = asObject(value);
  if (schema === undefined) return false;
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every(
      (member) =>
        member === null ||
        typeof member === "string" ||
        typeof member === "number" ||
        typeof member === "boolean",
    )
  ) {
    return true;
  }
  if (
    schema.const === null ||
    typeof schema.const === "string" ||
    typeof schema.const === "number" ||
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
  if (supportedPrimitiveSchema(schemaValue)) return true;
  const schema = asObject(schemaValue);
  if (schema === undefined) return false;
  if (schema.type === "array") return supportedPrimitiveSchema(schema.items);
  if (
    location !== "query" ||
    style !== "deepObject" ||
    schema.type !== "object"
  ) {
    return false;
  }
  const properties = asObject(schema.properties);
  return (
    properties !== undefined &&
    Object.values(properties).every(supportedPrimitiveSchema)
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
    return Object.entries(requirement).every(
      ([name, scopes]) =>
        Array.isArray(scopes) &&
        schemes !== undefined &&
        supportedSecurityScheme(schemes[name]),
    );
  });
}

function readServers(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const urls: string[] = [];
  for (const serverValue of value) {
    const server = asObject(serverValue);
    if (
      server === undefined ||
      typeof server.url !== "string" ||
      server.url === ""
    ) {
      return undefined;
    }
    urls.push(server.url);
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
  const eligibleCount = candidates.filter(
    (candidate) => candidate.eligibility.eligible,
  ).length;
  if (eligibleCount > 100) {
    throw new OpenApiImportError("OPENAPI_LIMIT_EXCEEDED");
  }
  if (eligibleCount === 0) {
    throw new OpenApiImportError("OPENAPI_UNSUPPORTED");
  }
  return Object.freeze(candidates);
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
    const resolved =
      direct ?? (aliasMatches?.length === 1 ? aliasMatches[0] : undefined);
    if (
      resolved === undefined ||
      (direct === undefined &&
        aliasMatches?.length !== undefined &&
        aliasMatches.length > 1) ||
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
