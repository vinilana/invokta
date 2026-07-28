import type { InstallerFileSystem } from "./file-system.js";
import { InstallerError } from "./installer-error.js";

export const configurationTargetIds = Object.freeze([
  "antigravity",
  "claude-code",
  "codex",
  "cursor",
  "grok-build",
  "hermes",
  "kimi-code",
  "openclaw",
  "opencode-v2",
] as const);

export type ConfigurationTargetId = (typeof configurationTargetIds)[number];

export interface StdioTransport {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly forwardEnv: readonly string[];
}

export interface StreamableHttpTransport {
  readonly type: "streamable-http";
  readonly url: string;
  readonly authentication:
    | { readonly type: "none" }
    | { readonly type: "bearer-env"; readonly variable: string };
  readonly headersFromEnv: Readonly<Record<string, string>>;
}

export interface CapabilityInstallDescriptor {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly capabilityIds: readonly string[];
  readonly server: {
    readonly name: string;
    readonly transport: StdioTransport | StreamableHttpTransport;
  };
}

export type RegistryCompatibility =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

export type RegistryCompatibilityAdapter = (
  descriptor: CapabilityInstallDescriptor,
) => RegistryCompatibility;

export type RegistryCompatibilityAdapters = Readonly<
  Record<ConfigurationTargetId, RegistryCompatibilityAdapter>
>;

export interface ValidatedRegistryEntry {
  readonly descriptor: CapabilityInstallDescriptor;
  readonly compatibility: Readonly<
    Record<ConfigurationTargetId, RegistryCompatibility>
  >;
}

export interface ValidatedRegistry {
  readonly schemaVersion: 1;
  readonly entries: readonly ValidatedRegistryEntry[];
}

export type RegistryIssueCode =
  | "ARRAY_TOO_LONG"
  | "ARRAY_TOO_SHORT"
  | "BOM_FORBIDDEN"
  | "CREDENTIAL_URL"
  | "DUPLICATE_HEADER"
  | "DUPLICATE_ID"
  | "DUPLICATE_KEY"
  | "DUPLICATE_SERVER_NAME"
  | "DUPLICATE_VALUE"
  | "EMPTY_STRING"
  | "INSECURE_URL"
  | "INVALID_ENV_NAME"
  | "INVALID_HEADER_NAME"
  | "INVALID_ID"
  | "INVALID_JSON"
  | "INVALID_SCHEMA_VERSION"
  | "INVALID_SERVER_NAME"
  | "INVALID_TRANSPORT"
  | "INVALID_TYPE"
  | "INVALID_UNICODE"
  | "INVALID_URL"
  | "INVALID_UTF8"
  | "NUL_FORBIDDEN"
  | "OBJECT_TOO_LARGE"
  | "REGISTRY_TOO_LARGE"
  | "REQUIRED"
  | "RESERVED_HEADER"
  | "STRING_TOO_LONG"
  | "UNKNOWN_KEY"
  | "UNSUPPORTED_BY_ALL_TARGETS";

export interface RegistryIssue {
  readonly pointer: string;
  readonly code: RegistryIssueCode;
}

export interface RegistryValidationCounters {
  pathLinksCreated: number;
  pathSegmentsRendered: number;
  entryValidationPasses: number;
  compatibilityCalls: number;
}

export type RegistryValidationResult =
  | { readonly ok: true; readonly registry: ValidatedRegistry }
  | { readonly ok: false; readonly issues: readonly RegistryIssue[] };

type JsonRecord = Record<string, unknown>;

interface JsonPath {
  readonly parent?: JsonPath;
  readonly segment?: string;
  readonly depth: number;
  readonly counters?: RegistryValidationCounters;
}

const registryByteLimit = 1_048_576;
const registryEntryLimit = 1_000;
const generalStringLimit = 4_096;
const idPattern = /^[a-z][a-z0-9-]{0,127}$/u;
const serverNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const environmentNamePattern = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const httpFieldNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const reservedHeaderNames = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const rootKeys = new Set(["schemaVersion", "entries"]);
const entryKeys = new Set([
  "id",
  "version",
  "title",
  "description",
  "capabilityIds",
  "server",
]);
const serverKeys = new Set(["name", "transport"]);
const stdioKeys = new Set(["type", "command", "args", "forwardEnv"]);
const httpKeys = new Set(["type", "url", "authentication", "headersFromEnv"]);
const authenticationNoneKeys = new Set(["type"]);
const authenticationBearerKeys = new Set(["type", "variable"]);

export const bundledRegistryUrl = new URL(
  "../registry/capabilities.json",
  import.meta.url,
);

class RegistryValidationFailure extends Error {
  readonly issues: readonly RegistryIssue[];

  constructor(issues: readonly RegistryIssue[]) {
    super("The registry failed internal validation.");
    this.name = "RegistryValidationFailure";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rootPath(counters?: RegistryValidationCounters): JsonPath {
  return counters === undefined ? { depth: 0 } : { depth: 0, counters };
}

function appendPath(path: JsonPath, segment: string): JsonPath {
  if (path.counters !== undefined) path.counters.pathLinksCreated += 1;
  return path.counters === undefined
    ? { parent: path, segment, depth: path.depth + 1 }
    : { parent: path, segment, depth: path.depth + 1, counters: path.counters };
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointer(path: JsonPath): string {
  if (path.depth === 0) return "";
  if (path.counters !== undefined) {
    path.counters.pathSegmentsRendered += path.depth;
  }
  const segments = new Array<string>(path.depth);
  let current = path;
  for (let index = path.depth - 1; index >= 0; index -= 1) {
    segments[index] = escapePointerSegment(current.segment as string);
    current = current.parent as JsonPath;
  }
  return `/${segments.join("/")}`;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  while (true) {
    const leftPart = leftIterator.next();
    const rightPart = rightIterator.next();
    if (leftPart.done || rightPart.done) {
      if (leftPart.done && rightPart.done) return 0;
      return leftPart.done ? -1 : 1;
    }
    const leftPoint = leftPart.value.codePointAt(0) as number;
    const rightPoint = rightPart.value.codePointAt(0) as number;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
}

function orderedIssues(
  issues: readonly RegistryIssue[],
): readonly RegistryIssue[] {
  const unique = new Map<string, RegistryIssue>();
  for (const issue of issues) {
    unique.set(`${issue.pointer}\u0000${issue.code}`, issue);
  }
  return Object.freeze(
    [...unique.values()]
      .sort((left, right) => {
        const pathOrder = compareUnicodeCodePoints(left.pointer, right.pointer);
        return pathOrder === 0
          ? compareUnicodeCodePoints(left.code, right.code)
          : pathOrder;
      })
      .map((issue) => Object.freeze({ ...issue })),
  );
}

function invalid(issues: readonly RegistryIssue[]): RegistryValidationResult {
  return { ok: false, issues: orderedIssues(issues) };
}

function addIssue(
  issues: RegistryIssue[],
  path: JsonPath,
  code: RegistryIssueCode,
): void {
  issues.push({ pointer: pointer(path), code });
}

function unicodeScalarLength(value: string): number | undefined {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return undefined;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return undefined;
    }
    length += 1;
  }
  return length;
}

function validateStringValue(
  value: string,
  path: JsonPath,
  issues: RegistryIssue[],
  limit = generalStringLimit,
): void {
  const length = unicodeScalarLength(value);
  if (length === undefined) {
    addIssue(issues, path, "INVALID_UNICODE");
  } else if (length > limit) {
    addIssue(issues, path, "STRING_TOO_LONG");
  }
}

function validateAllStrings(
  value: unknown,
  root: JsonPath,
  issues: RegistryIssue[],
): void {
  const work: Array<{ value: unknown; path: JsonPath }> = [
    { value, path: root },
  ];
  while (work.length > 0) {
    const current = work.pop();
    if (current === undefined) break;
    if (typeof current.value === "string") {
      validateStringValue(current.value, current.path, issues);
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        work.push({
          value: current.value[index],
          path: appendPath(current.path, String(index)),
        });
      }
      continue;
    }
    if (!isRecord(current.value)) continue;
    const keys = Object.keys(current.value);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index] as string;
      const childPath = appendPath(current.path, key);
      validateStringValue(key, childPath, issues);
      work.push({ value: current.value[key], path: childPath });
    }
  }
}

function validateObjectShape(
  value: unknown,
  path: JsonPath,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  issues: RegistryIssue[],
): value is JsonRecord {
  if (!isRecord(value)) {
    addIssue(issues, path, "INVALID_TYPE");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      addIssue(issues, appendPath(path, key), "UNKNOWN_KEY");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      addIssue(issues, appendPath(path, key), "REQUIRED");
  }
  return true;
}

function validateStringField(
  value: unknown,
  path: JsonPath,
  issues: RegistryIssue[],
  options: {
    readonly trimmedNonempty?: boolean | undefined;
    readonly limit?: number | undefined;
  } = {},
): value is string {
  if (typeof value !== "string") {
    if (value !== undefined) addIssue(issues, path, "INVALID_TYPE");
    return false;
  }
  validateStringValue(value, path, issues, options.limit);
  if (options.trimmedNonempty === true && value.trim() === "") {
    addIssue(issues, path, "EMPTY_STRING");
  }
  return true;
}

function validateStringArray(
  value: unknown,
  path: JsonPath,
  issues: RegistryIssue[],
  options: {
    readonly maximum: number;
    readonly minimum?: number;
    readonly unique?: boolean;
    readonly trimmedNonempty?: boolean | undefined;
    readonly environmentNames?: boolean;
  },
): value is string[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) addIssue(issues, path, "INVALID_TYPE");
    return false;
  }
  if (value.length > options.maximum) addIssue(issues, path, "ARRAY_TOO_LONG");
  if (value.length < (options.minimum ?? 0))
    addIssue(issues, path, "ARRAY_TOO_SHORT");
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = appendPath(path, String(index));
    const item = value[index];
    if (
      !validateStringField(item, itemPath, issues, {
        trimmedNonempty: options.trimmedNonempty,
      })
    ) {
      continue;
    }
    if (options.unique === true) {
      if (seen.has(item)) addIssue(issues, itemPath, "DUPLICATE_VALUE");
      else seen.add(item);
    }
    if (
      options.environmentNames === true &&
      !environmentNamePattern.test(item)
    ) {
      addIssue(issues, itemPath, "INVALID_ENV_NAME");
    }
  }
  return true;
}

function validateUrl(
  value: string,
  path: JsonPath,
  issues: RegistryIssue[],
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    addIssue(issues, path, "INVALID_URL");
    return;
  }
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator <= 0) {
    addIssue(issues, path, "INVALID_URL");
    return;
  }
  const authorityStart = schemeSeparator + 3;
  const authorityTail = value.slice(authorityStart);
  const authorityEnd = authorityTail.search(/[/?#]/u);
  const authority = authorityTail.slice(
    0,
    authorityEnd === -1 ? undefined : authorityEnd,
  );
  const rawTarget =
    authorityEnd === -1 ? "" : authorityTail.slice(authorityEnd);
  const queryOrFragment = rawTarget.search(/[?#]/u);
  const rawPath = rawTarget.slice(
    0,
    queryOrFragment === -1 ? undefined : queryOrFragment,
  );
  const rawHost = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : authority.split(":", 1)[0];
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    addIssue(issues, path, "INVALID_URL");
  }
  if (authority.includes("@") || url.username !== "" || url.password !== "") {
    addIssue(issues, path, "CREDENTIAL_URL");
  }
  if (
    authority === "" ||
    url.hostname === "" ||
    rawPath !== "/mcp" ||
    url.pathname !== "/mcp" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    addIssue(issues, path, "INVALID_URL");
  }
  if (
    url.protocol === "http:" &&
    rawHost !== "127.0.0.1" &&
    rawHost !== "[::1]"
  ) {
    addIssue(issues, path, "INSECURE_URL");
  }
}

function validateAuthentication(
  value: unknown,
  path: JsonPath,
  issues: RegistryIssue[],
): "none" | "bearer-env" | undefined {
  if (value === undefined) return "none";
  if (!isRecord(value)) {
    addIssue(issues, path, "INVALID_TYPE");
    return undefined;
  }
  const type = value.type;
  if (type === "none") {
    validateObjectShape(value, path, authenticationNoneKeys, ["type"], issues);
    return "none";
  }
  if (type === "bearer-env") {
    validateObjectShape(
      value,
      path,
      authenticationBearerKeys,
      ["type", "variable"],
      issues,
    );
    const variablePath = appendPath(path, "variable");
    if (validateStringField(value.variable, variablePath, issues)) {
      if (!environmentNamePattern.test(value.variable)) {
        addIssue(issues, variablePath, "INVALID_ENV_NAME");
      }
    }
    return "bearer-env";
  }
  validateObjectShape(value, path, authenticationNoneKeys, ["type"], issues);
  if (type !== undefined && typeof type !== "string") {
    addIssue(issues, appendPath(path, "type"), "INVALID_TYPE");
  } else {
    addIssue(issues, appendPath(path, "type"), "INVALID_TRANSPORT");
  }
  return undefined;
}

function validateHeaders(
  value: unknown,
  path: JsonPath,
  authentication: "none" | "bearer-env" | undefined,
  issues: RegistryIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    addIssue(issues, path, "INVALID_TYPE");
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > 64) addIssue(issues, path, "OBJECT_TOO_LARGE");
  const seen = new Set<string>();
  for (const key of keys) {
    const headerPath = appendPath(path, key);
    const normalized = key.toLowerCase();
    if (!httpFieldNamePattern.test(key)) {
      addIssue(issues, headerPath, "INVALID_HEADER_NAME");
    }
    if (seen.has(normalized)) addIssue(issues, headerPath, "DUPLICATE_HEADER");
    else seen.add(normalized);
    if (
      reservedHeaderNames.has(normalized) ||
      (authentication === "bearer-env" && normalized === "authorization")
    ) {
      addIssue(issues, headerPath, "RESERVED_HEADER");
    }
    const environmentName = value[key];
    if (validateStringField(environmentName, headerPath, issues)) {
      if (!environmentNamePattern.test(environmentName)) {
        addIssue(issues, headerPath, "INVALID_ENV_NAME");
      }
    }
  }
}

function validateTransport(
  value: unknown,
  path: JsonPath,
  issues: RegistryIssue[],
): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "INVALID_TYPE");
    return;
  }
  const type = value.type;
  if (type === "stdio") {
    validateObjectShape(value, path, stdioKeys, ["type", "command"], issues);
    const commandPath = appendPath(path, "command");
    if (validateStringField(value.command, commandPath, issues)) {
      if (value.command === "") addIssue(issues, commandPath, "EMPTY_STRING");
      if (value.command.includes("\u0000"))
        addIssue(issues, commandPath, "NUL_FORBIDDEN");
    }
    if (value.args !== undefined) {
      validateStringArray(value.args, appendPath(path, "args"), issues, {
        maximum: 128,
      });
    }
    if (value.forwardEnv !== undefined) {
      validateStringArray(
        value.forwardEnv,
        appendPath(path, "forwardEnv"),
        issues,
        { maximum: 64, unique: true, environmentNames: true },
      );
    }
    return;
  }
  if (type === "streamable-http") {
    validateObjectShape(value, path, httpKeys, ["type", "url"], issues);
    const urlPath = appendPath(path, "url");
    if (validateStringField(value.url, urlPath, issues)) {
      validateUrl(value.url, urlPath, issues);
    }
    const authentication = validateAuthentication(
      value.authentication,
      appendPath(path, "authentication"),
      issues,
    );
    validateHeaders(
      value.headersFromEnv,
      appendPath(path, "headersFromEnv"),
      authentication,
      issues,
    );
    return;
  }

  validateObjectShape(value, path, new Set(["type"]), ["type"], issues);
  const typePath = appendPath(path, "type");
  if (type !== undefined && typeof type !== "string") {
    addIssue(issues, typePath, "INVALID_TYPE");
  } else {
    addIssue(issues, typePath, "INVALID_TRANSPORT");
  }
}

function validateEntry(
  value: unknown,
  index: number,
  root: JsonPath,
  issues: RegistryIssue[],
  ids: Set<string>,
  serverNames: Set<string>,
): value is JsonRecord {
  const path = appendPath(appendPath(root, "entries"), String(index));
  if (
    !validateObjectShape(
      value,
      path,
      entryKeys,
      ["id", "version", "title", "description", "capabilityIds", "server"],
      issues,
    )
  ) {
    return false;
  }

  const idPath = appendPath(path, "id");
  if (validateStringField(value.id, idPath, issues)) {
    if (!idPattern.test(value.id)) addIssue(issues, idPath, "INVALID_ID");
    if (ids.has(value.id)) addIssue(issues, idPath, "DUPLICATE_ID");
    else ids.add(value.id);
  }
  validateStringField(value.version, appendPath(path, "version"), issues, {
    trimmedNonempty: true,
  });
  validateStringField(value.title, appendPath(path, "title"), issues, {
    trimmedNonempty: true,
    limit: 120,
  });
  validateStringField(
    value.description,
    appendPath(path, "description"),
    issues,
    { trimmedNonempty: true, limit: 1_000 },
  );
  validateStringArray(
    value.capabilityIds,
    appendPath(path, "capabilityIds"),
    issues,
    { maximum: 100, minimum: 1, unique: true, trimmedNonempty: true },
  );

  const serverPath = appendPath(path, "server");
  if (
    validateObjectShape(
      value.server,
      serverPath,
      serverKeys,
      ["name", "transport"],
      issues,
    )
  ) {
    const namePath = appendPath(serverPath, "name");
    if (validateStringField(value.server.name, namePath, issues)) {
      if (!serverNamePattern.test(value.server.name)) {
        addIssue(issues, namePath, "INVALID_SERVER_NAME");
      }
      if (serverNames.has(value.server.name)) {
        addIssue(issues, namePath, "DUPLICATE_SERVER_NAME");
      } else {
        serverNames.add(value.server.name);
      }
    }
    validateTransport(
      value.server.transport,
      appendPath(serverPath, "transport"),
      issues,
    );
  }
  return true;
}

function readJsonString(
  text: string,
  start: number,
): { value: string; end: number } {
  let end = start + 1;
  while (end < text.length) {
    const character = text[end];
    if (character === "\\") {
      end += 2;
      continue;
    }
    end += 1;
    if (character === '"') break;
  }
  return {
    value: JSON.parse(text.slice(start, end)) as string,
    end,
  };
}

type JsonToken =
  | { readonly kind: "string"; readonly value: string; readonly end: number }
  | {
      readonly kind: "punctuation";
      readonly value: string;
      readonly end: number;
    }
  | { readonly kind: "scalar"; readonly end: number };

function nextJsonToken(text: string, start: number): JsonToken | undefined {
  let index = start;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  if (index >= text.length) return undefined;
  const character = text[index] as string;
  if (character === '"') {
    const string = readJsonString(text, index);
    return { kind: "string", value: string.value, end: string.end };
  }
  if ("{}[]:,".includes(character)) {
    return { kind: "punctuation", value: character, end: index + 1 };
  }
  let end = index + 1;
  while (end < text.length) {
    const current = text[end] as string;
    if (/\s/u.test(current) || "{}[],:".includes(current)) break;
    end += 1;
  }
  return { kind: "scalar", end };
}

interface ObjectFrame {
  readonly kind: "object";
  readonly path: JsonPath;
  readonly keys: Set<string>;
  state: "key-or-end" | "colon" | "value" | "comma-or-end";
  key?: string;
}

interface ArrayFrame {
  readonly kind: "array";
  readonly path: JsonPath;
  state: "value-or-end" | "comma-or-end";
  index: number;
}

type JsonFrame = ObjectFrame | ArrayFrame;

function duplicateKeyIssues(text: string, root: JsonPath): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const stack: JsonFrame[] = [];
  let offset = 0;
  let rootConsumed = false;

  const consumeValue = (token: JsonToken, path: JsonPath): void => {
    const parent = stack.at(-1);
    if (parent === undefined) {
      rootConsumed = true;
    } else if (parent.kind === "object") {
      parent.state = "comma-or-end";
      delete parent.key;
    } else {
      parent.state = "comma-or-end";
      parent.index += 1;
    }
    if (token.kind !== "punctuation") return;
    if (token.value === "{") {
      stack.push({
        kind: "object",
        path,
        keys: new Set(),
        state: "key-or-end",
      });
    } else if (token.value === "[") {
      stack.push({ kind: "array", path, state: "value-or-end", index: 0 });
    }
  };

  while (true) {
    const token = nextJsonToken(text, offset);
    if (token === undefined) break;
    offset = token.end;
    const frame = stack.at(-1);
    if (frame === undefined) {
      if (!rootConsumed) consumeValue(token, root);
      continue;
    }
    if (frame.kind === "object") {
      if (frame.state === "key-or-end") {
        if (token.kind === "punctuation" && token.value === "}") {
          stack.pop();
        } else if (token.kind === "string") {
          if (frame.keys.has(token.value))
            addIssue(
              issues,
              appendPath(frame.path, token.value),
              "DUPLICATE_KEY",
            );
          else frame.keys.add(token.value);
          frame.key = token.value;
          frame.state = "colon";
        }
      } else if (frame.state === "colon") {
        frame.state = "value";
      } else if (frame.state === "value") {
        consumeValue(token, appendPath(frame.path, frame.key as string));
      } else if (token.kind === "punctuation" && token.value === ",") {
        frame.state = "key-or-end";
      } else if (token.kind === "punctuation" && token.value === "}") {
        stack.pop();
      }
      continue;
    }
    if (frame.state === "value-or-end") {
      if (token.kind === "punctuation" && token.value === "]") {
        stack.pop();
      } else {
        consumeValue(token, appendPath(frame.path, String(frame.index)));
      }
    } else if (token.kind === "punctuation" && token.value === ",") {
      frame.state = "value-or-end";
    } else if (token.kind === "punctuation" && token.value === "]") {
      stack.pop();
    }
  }
  return issues;
}

function freezeStringArray(
  value: readonly string[] | undefined,
): readonly string[] {
  return Object.freeze([...(value ?? [])]);
}

function normalizeHeaders(
  value: JsonRecord | undefined,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (value !== undefined) {
    const entries = Object.entries(value)
      .map(
        ([name, environment]) =>
          [name.toLowerCase(), environment as string] as const,
      )
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right));
    for (const [name, environment] of entries) {
      Object.defineProperty(headers, name, {
        configurable: false,
        enumerable: true,
        value: environment,
        writable: false,
      });
    }
  }
  return Object.freeze(headers);
}

function normalizeDescriptor(value: JsonRecord): CapabilityInstallDescriptor {
  const server = value.server as JsonRecord;
  const rawTransport = server.transport as JsonRecord;
  let transport: StdioTransport | StreamableHttpTransport;
  if (rawTransport.type === "stdio") {
    transport = Object.freeze({
      type: "stdio",
      command: rawTransport.command as string,
      args: freezeStringArray(rawTransport.args as string[] | undefined),
      forwardEnv: freezeStringArray(
        rawTransport.forwardEnv as string[] | undefined,
      ),
    });
  } else {
    const rawAuthentication = rawTransport.authentication as
      | JsonRecord
      | undefined;
    const authentication =
      rawAuthentication?.type === "bearer-env"
        ? Object.freeze({
            type: "bearer-env" as const,
            variable: rawAuthentication.variable as string,
          })
        : Object.freeze({ type: "none" as const });
    transport = Object.freeze({
      type: "streamable-http",
      url: new URL(rawTransport.url as string).href,
      authentication,
      headersFromEnv: normalizeHeaders(
        rawTransport.headersFromEnv as JsonRecord | undefined,
      ),
    });
  }
  return Object.freeze({
    id: value.id as string,
    version: value.version as string,
    title: value.title as string,
    description: value.description as string,
    capabilityIds: freezeStringArray(value.capabilityIds as string[]),
    server: Object.freeze({ name: server.name as string, transport }),
  });
}

function compatibilityRecord(
  descriptor: CapabilityInstallDescriptor,
  adapters: RegistryCompatibilityAdapters,
  counters: RegistryValidationCounters | undefined,
): Readonly<Record<ConfigurationTargetId, RegistryCompatibility>> {
  const result = {} as Record<ConfigurationTargetId, RegistryCompatibility>;
  for (const targetId of configurationTargetIds) {
    if (counters !== undefined) counters.compatibilityCalls += 1;
    result[targetId] = Object.freeze(adapters[targetId](descriptor));
  }
  return Object.freeze(result);
}

export function validateRegistryBytes(
  bytes: Uint8Array,
  adapters: RegistryCompatibilityAdapters,
  counters?: RegistryValidationCounters,
): RegistryValidationResult {
  if (bytes.byteLength > registryByteLimit) {
    return invalid([{ pointer: "", code: "REGISTRY_TOO_LARGE" }]);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return invalid([{ pointer: "", code: "BOM_FORBIDDEN" }]);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return invalid([{ pointer: "", code: "INVALID_UTF8" }]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return invalid([{ pointer: "", code: "INVALID_JSON" }]);
  }

  const root = rootPath(counters);
  const issues = duplicateKeyIssues(text, root);
  validateAllStrings(parsed, root, issues);
  if (
    !validateObjectShape(
      parsed,
      root,
      rootKeys,
      ["schemaVersion", "entries"],
      issues,
    )
  ) {
    return invalid(issues);
  }
  if (parsed.schemaVersion !== 1) {
    addIssue(
      issues,
      appendPath(root, "schemaVersion"),
      "INVALID_SCHEMA_VERSION",
    );
  }
  if (!Array.isArray(parsed.entries)) {
    if (parsed.entries !== undefined)
      addIssue(issues, appendPath(root, "entries"), "INVALID_TYPE");
    return invalid(issues);
  }
  if (parsed.entries.length > registryEntryLimit) {
    addIssue(issues, appendPath(root, "entries"), "ARRAY_TOO_LONG");
  }

  const validEntries: JsonRecord[] = [];
  const ids = new Set<string>();
  const serverNames = new Set<string>();
  for (let index = 0; index < parsed.entries.length; index += 1) {
    if (counters !== undefined) counters.entryValidationPasses += 1;
    const entry = parsed.entries[index];
    if (validateEntry(entry, index, root, issues, ids, serverNames)) {
      validEntries.push(entry);
    }
  }
  if (issues.length > 0) return invalid(issues);

  const entriesWithSourceIndex = validEntries.map((entry, sourceIndex) => {
    const descriptor = normalizeDescriptor(entry);
    const compatibility = compatibilityRecord(descriptor, adapters, counters);
    if (!Object.values(compatibility).some((result) => result.supported)) {
      addIssue(
        issues,
        appendPath(
          appendPath(
            appendPath(appendPath(root, "entries"), String(sourceIndex)),
            "server",
          ),
          "transport",
        ),
        "UNSUPPORTED_BY_ALL_TARGETS",
      );
    }
    return { sourceIndex, entry: Object.freeze({ descriptor, compatibility }) };
  });
  if (issues.length > 0) return invalid(issues);

  const sorted = entriesWithSourceIndex
    .map(({ entry }) => entry)
    .sort((left, right) => {
      const titleOrder = compareUnicodeCodePoints(
        left.descriptor.title,
        right.descriptor.title,
      );
      return titleOrder === 0
        ? compareUnicodeCodePoints(left.descriptor.id, right.descriptor.id)
        : titleOrder;
    });
  return {
    ok: true,
    registry: Object.freeze({
      schemaVersion: 1,
      entries: Object.freeze(sorted),
    }),
  };
}

export async function loadBundledRegistry(
  fileSystem: InstallerFileSystem,
  adapters: RegistryCompatibilityAdapters,
): Promise<ValidatedRegistry> {
  let bytes: Uint8Array;
  try {
    bytes = await fileSystem.readFile(bundledRegistryUrl);
  } catch (cause) {
    throw new InstallerError("REGISTRY_INVALID", cause);
  }
  const result = validateRegistryBytes(bytes, adapters);
  if (!result.ok) {
    throw new InstallerError(
      "REGISTRY_INVALID",
      new RegistryValidationFailure(result.issues),
    );
  }
  return result.registry;
}
