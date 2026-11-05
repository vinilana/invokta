import type { EngineJsonSchema } from "@invokta/core";

/**
 * Maps annotated top-level output properties to MCP image, audio, and
 * resource-link content blocks (ADR 0044). The plan is derived once per tool
 * from the captured output JSON Schema; the result mapping is a pure function
 * of that plan, the validated output, and the negotiated protocol revision, so
 * stdio and HTTP present the same capability result identically.
 */

/** Planned values presented for one result, besides the JSON text block. */
export const MAX_TOOL_CONTENT_BLOCKS = 16;

const MAX_LINK_URI_LENGTH = 8_192;
const MAX_LINK_NAME_BYTES = 1_024;
const MAX_LINK_MIME_TYPE_LENGTH = 255;
const LINK_URI_MEDIA_TYPE = "text/uri-list";

/** The first protocol revision that defines each generated block type. */
const AUDIO_SINCE_PROTOCOL = "2025-03-26";
const RESOURCE_LINK_SINCE_PROTOCOL = "2025-06-18";

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const AUDIO_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "audio/wav",
  "audio/mpeg",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/aac",
]);

// RFC 9110 media type: `type/subtype` with optional parameters.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const QUOTED_STRING =
  '"(?:[\\t \\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\t \\x21-\\x7e])*"';
const MEDIA_TYPE_PATTERN = new RegExp(
  `^${TOKEN}/${TOKEN}(?:[\\t ]*;[\\t ]*${TOKEN}=(?:${TOKEN}|${QUOTED_STRING}))*$`,
  "u",
);
const LINK_SCHEME_PATTERN = /^https?:\/\//iu;
const MEDIA_FAMILY_PATTERN = /^(?:image|audio)\//iu;

type JsonRecord = Readonly<Record<string, unknown>>;

type ContentForm =
  | { readonly kind: "media"; readonly mimeType: string }
  | {
      readonly kind: "media-object";
      readonly dataKey: string;
      readonly mimeTypes: ReadonlySet<string>;
    }
  | { readonly kind: "resource-link" };

interface PlannedProperty {
  readonly key: string;
  readonly list: boolean;
  readonly form: ContentForm;
}

export type McpToolContentPlan = ReadonlyArray<PlannedProperty>;

// Type aliases rather than interfaces, so results satisfy the SDK's indexed
// result type without importing it here.
type TextContentBlock = {
  readonly type: "text";
  readonly text: string;
};

type MediaContentBlock = {
  readonly type: "image" | "audio";
  readonly data: string;
  readonly mimeType: string;
};

type ResourceLinkContentBlock = {
  readonly type: "resource_link";
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string;
};

type GeneratedContentBlock = MediaContentBlock | ResourceLinkContentBlock;

export type McpToolCallResult = {
  readonly content: Array<TextContentBlock | GeneratedContentBlock>;
  readonly structuredContent: JsonRecord;
};

export type McpToolContentWarningCode =
  | "UNSUPPORTED_MEDIA_TYPE"
  | "MEDIA_WITHOUT_BASE64"
  | "AMBIGUOUS_MEDIA_OBJECT"
  | "INCOMPLETE_RESOURCE_LINK"
  | "UNSUPPORTED_POSITION"
  | "CONTENT_BLOCK_LIMIT";

export interface McpToolContentWarning {
  readonly capabilityId: string;
  readonly toolName: string;
  /** The top-level output property the warning refers to. */
  readonly property: string;
  readonly code: McpToolContentWarningCode;
}

export interface McpToolCatalogReport {
  readonly contentWarnings: ReadonlyArray<McpToolContentWarning>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(record: JsonRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function mediaBlockType(mimeType: unknown): "image" | "audio" | undefined {
  if (typeof mimeType !== "string") return undefined;
  if (IMAGE_MEDIA_TYPES.has(mimeType)) return "image";
  if (AUDIO_MEDIA_TYPES.has(mimeType)) return "audio";
  return undefined;
}

function isStringSchema(schema: unknown): schema is JsonRecord {
  return isRecord(schema) && ownValue(schema, "type") === "string";
}

function isBase64StringSchema(schema: unknown): boolean {
  return (
    isStringSchema(schema) && ownValue(schema, "contentEncoding") === "base64"
  );
}

function declaredValues(schema: JsonRecord): unknown[] {
  const enumValues = ownValue(schema, "enum");
  return [
    ...(Object.hasOwn(schema, "const") ? [ownValue(schema, "const")] : []),
    ...(Array.isArray(enumValues) ? enumValues : []),
  ];
}

function declaredMediaTypes(schema: unknown): ReadonlySet<string> | undefined {
  if (!isStringSchema(schema)) return undefined;
  const values = declaredValues(schema);
  if (values.length === 0) return undefined;
  if (!values.every((value) => mediaBlockType(value) !== undefined)) {
    return undefined;
  }
  return new Set(values as string[]);
}

function base64PropertyKeys(properties: JsonRecord): string[] {
  return Object.keys(properties).filter(
    (key) => key !== "mimeType" && isBase64StringSchema(properties[key]),
  );
}

function isResourceLinkSchema(properties: JsonRecord): boolean {
  const uri = ownValue(properties, "uri");
  return (
    isStringSchema(uri) &&
    ownValue(uri, "contentMediaType") === LINK_URI_MEDIA_TYPE &&
    isStringSchema(ownValue(properties, "name")) &&
    (!Object.hasOwn(properties, "mimeType") ||
      isStringSchema(ownValue(properties, "mimeType")))
  );
}

function recognizeForm(schema: unknown): ContentForm | undefined {
  if (!isRecord(schema)) return undefined;
  const type = ownValue(schema, "type");
  if (type === "string") {
    const mimeType = ownValue(schema, "contentMediaType");
    return isBase64StringSchema(schema) &&
      mediaBlockType(mimeType) !== undefined
      ? { kind: "media", mimeType: mimeType as string }
      : undefined;
  }
  const properties = ownValue(schema, "properties");
  if (type !== "object" || !isRecord(properties)) return undefined;
  if (isResourceLinkSchema(properties)) return { kind: "resource-link" };

  const mimeTypes = declaredMediaTypes(ownValue(properties, "mimeType"));
  if (mimeTypes === undefined) return undefined;
  const dataKeys = base64PropertyKeys(properties);
  const [dataKey] = dataKeys;
  return dataKeys.length === 1 && dataKey !== undefined
    ? { kind: "media-object", dataKey, mimeTypes }
    : undefined;
}

function topLevelProperties(outputSchema: EngineJsonSchema): JsonRecord {
  const properties = ownValue(outputSchema, "properties");
  return ownValue(outputSchema, "type") === "object" && isRecord(properties)
    ? properties
    : {};
}

function listItems(schema: unknown): unknown {
  return isRecord(schema) && ownValue(schema, "type") === "array"
    ? ownValue(schema, "items")
    : undefined;
}

/** Derives the content plan of one tool from its output JSON Schema. */
export function planMcpToolContent(
  outputSchema: EngineJsonSchema,
): McpToolContentPlan {
  const properties = topLevelProperties(outputSchema);
  const plan: PlannedProperty[] = [];
  for (const key of Object.keys(properties)) {
    const schema = properties[key];
    const items = listItems(schema);
    const list = items !== undefined;
    const form = recognizeForm(list ? items : schema);
    if (form !== undefined) plan.push(Object.freeze({ key, list, form }));
  }
  return Object.freeze(plan);
}

function isMediaLike(value: unknown): boolean {
  return typeof value === "string" && MEDIA_FAMILY_PATTERN.test(value);
}

function isLinkLike(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.toLowerCase().startsWith(LINK_URI_MEDIA_TYPE)
  );
}

/** A schema node that carries a content annotation the adapter recognizes. */
function hasContentSignal(node: JsonRecord): boolean {
  const contentMediaType = ownValue(node, "contentMediaType");
  if (isMediaLike(contentMediaType) || isLinkLike(contentMediaType)) {
    return true;
  }
  const properties = ownValue(node, "properties");
  const mimeType = isRecord(properties)
    ? ownValue(properties, "mimeType")
    : undefined;
  return isRecord(mimeType) && declaredValues(mimeType).some(isMediaLike);
}

function nearMiss(schema: unknown): McpToolContentWarningCode | undefined {
  if (!isRecord(schema)) return undefined;
  if (isStringSchema(schema)) {
    const contentMediaType = ownValue(schema, "contentMediaType");
    if (isLinkLike(contentMediaType)) return "INCOMPLETE_RESOURCE_LINK";
    if (!isMediaLike(contentMediaType)) return undefined;
    return mediaBlockType(contentMediaType) === undefined
      ? "UNSUPPORTED_MEDIA_TYPE"
      : "MEDIA_WITHOUT_BASE64";
  }
  const properties = ownValue(schema, "properties");
  if (ownValue(schema, "type") !== "object" || !isRecord(properties)) {
    return undefined;
  }
  const uri = ownValue(properties, "uri");
  if (isRecord(uri) && isLinkLike(ownValue(uri, "contentMediaType"))) {
    return "INCOMPLETE_RESOURCE_LINK";
  }
  const mimeType = ownValue(properties, "mimeType");
  if (!isRecord(mimeType)) return undefined;
  const values = declaredValues(mimeType);
  if (!values.some(isMediaLike)) return undefined;
  if (declaredMediaTypes(mimeType) === undefined) {
    return "UNSUPPORTED_MEDIA_TYPE";
  }
  return base64PropertyKeys(properties).length === 0
    ? "MEDIA_WITHOUT_BASE64"
    : "AMBIGUOUS_MEDIA_OBJECT";
}

/** Finds a content annotation anywhere below an unrecognized property. */
function containsContentSignal(schema: unknown): boolean {
  const pending: unknown[] = [schema];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null || seen.has(node)) continue;
    seen.add(node);
    if (!Array.isArray(node) && hasContentSignal(node as JsonRecord)) {
      return true;
    }
    pending.push(...Object.values(node));
  }
  return false;
}

function maximumListLength(schema: unknown): number {
  const maxItems = isRecord(schema) ? ownValue(schema, "maxItems") : undefined;
  return typeof maxItems === "number" &&
    Number.isSafeInteger(maxItems) &&
    maxItems >= 0
    ? maxItems
    : Number.POSITIVE_INFINITY;
}

/**
 * Explains, without reading any value, why annotated output properties of one
 * tool will not produce content blocks, and whether its contract permits more
 * planned values than one result may present.
 */
export function diagnoseMcpToolContent(
  outputSchema: EngineJsonSchema,
): ReadonlyArray<{
  readonly property: string;
  readonly code: McpToolContentWarningCode;
}> {
  const properties = topLevelProperties(outputSchema);
  const warnings: { property: string; code: McpToolContentWarningCode }[] = [];
  let maximumBlocks = 0;
  let limitReported = false;
  for (const key of Object.keys(properties)) {
    const schema = properties[key];
    const items = listItems(schema);
    const candidate = items === undefined ? schema : items;
    if (recognizeForm(candidate) !== undefined) {
      maximumBlocks += items === undefined ? 1 : maximumListLength(schema);
      if (!limitReported && maximumBlocks > MAX_TOOL_CONTENT_BLOCKS) {
        limitReported = true;
        warnings.push({ property: key, code: "CONTENT_BLOCK_LIMIT" });
      }
      continue;
    }
    const code =
      nearMiss(candidate) ??
      (containsContentSignal(schema) ? "UNSUPPORTED_POSITION" : undefined);
    if (code !== undefined) warnings.push({ property: key, code });
  }
  return warnings;
}

/** Builds the payload-free content report for a validated tool catalog. */
export function createMcpToolCatalogReport(
  tools: Iterable<{
    readonly capabilityId: string;
    readonly toolName: string;
    readonly outputSchema: EngineJsonSchema;
  }>,
): McpToolCatalogReport {
  const contentWarnings: McpToolContentWarning[] = [];
  for (const { capabilityId, toolName, outputSchema } of tools) {
    for (const { property, code } of diagnoseMcpToolContent(outputSchema)) {
      contentWarnings.push(
        Object.freeze({ capabilityId, toolName, property, code }),
      );
    }
  }
  return Object.freeze({ contentWarnings: Object.freeze(contentWarnings) });
}

function isBase64Code(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47
  );
}

/** Accepts non-empty, padded RFC 4648 base64 with the standard alphabet. */
function isBase64(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = value.length;
  if (length === 0 || length % 4 !== 0) return false;
  let end = length;
  if (value.charCodeAt(end - 1) === 61) end -= 1;
  if (value.charCodeAt(end - 1) === 61) end -= 1;
  for (let index = 0; index < end; index += 1) {
    if (!isBase64Code(value.charCodeAt(index))) return false;
  }
  return true;
}

function isHexCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

/** RFC 3986 characters only, with well-formed percent-encoding. */
function isRfc3986(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 37) {
      if (
        !isHexCode(value.charCodeAt(index + 1)) ||
        !isHexCode(value.charCodeAt(index + 2))
      ) {
        return false;
      }
      index += 2;
      continue;
    }
    const allowed =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      "-._~:/?#[]@!$&'()*+,;=".includes(String.fromCharCode(code));
    if (!allowed) return false;
  }
  return true;
}

/**
 * Returns the normalized URL a resource link carries, or `undefined`. The raw
 * value must be unambiguous across URL parsers: an `http(s)` scheme in any
 * case, a non-empty authority without user information, and no whitespace,
 * control character, or backslash.
 */
function linkUri(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_LINK_URI_LENGTH
  ) {
    return undefined;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return undefined;
  }
  const scheme = LINK_SCHEME_PATTERN.exec(value);
  if (scheme === null) return undefined;
  const tail = value.slice(scheme[0].length);
  const authorityEnd = tail.search(/[/?#]/u);
  const authority = authorityEnd === -1 ? tail : tail.slice(0, authorityEnd);
  if (authority === "" || authority.includes("@")) return undefined;
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return undefined;
  }
  const href = url.href;
  return href.length <= MAX_LINK_URI_LENGTH && isRfc3986(href)
    ? href
    : undefined;
}

function isLinkName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    // A UTF-8 encoding is never shorter than the UTF-16 length.
    value.length <= MAX_LINK_NAME_BYTES &&
    new TextEncoder().encode(value).byteLength <= MAX_LINK_NAME_BYTES
  );
}

function isLinkMimeType(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length <= MAX_LINK_MIME_TYPE_LENGTH &&
      MEDIA_TYPE_PATTERN.test(value))
  );
}

function supportsBlock(
  type: GeneratedContentBlock["type"],
  protocolVersion: string,
): boolean {
  if (type === "audio") return protocolVersion >= AUDIO_SINCE_PROTOCOL;
  if (type === "resource_link") {
    return protocolVersion >= RESOURCE_LINK_SINCE_PROTOCOL;
  }
  return true;
}

/** The text-block stand-in for base64 data that a generated block carries. */
function placeholder(contentIndex: number, mimeType: string): string {
  return `[content ${String(contentIndex)}: ${mimeType}]`;
}

interface MappedValue {
  readonly block: GeneratedContentBlock;
  /** The value that replaces the original one in the text block. */
  readonly text: unknown;
}

function mapForm(
  form: ContentForm,
  value: unknown,
  contentIndex: number,
): MappedValue | undefined {
  switch (form.kind) {
    case "media": {
      const type = mediaBlockType(form.mimeType);
      if (type === undefined || !isBase64(value)) return undefined;
      return {
        block: { type, data: value, mimeType: form.mimeType },
        text: placeholder(contentIndex, form.mimeType),
      };
    }
    case "media-object": {
      if (!isRecord(value)) return undefined;
      const mimeType = ownValue(value, "mimeType");
      const data = ownValue(value, form.dataKey);
      const type = mediaBlockType(mimeType);
      if (
        type === undefined ||
        !form.mimeTypes.has(mimeType as string) ||
        !isBase64(data)
      ) {
        return undefined;
      }
      const stand = placeholder(contentIndex, mimeType as string);
      return {
        block: { type, data, mimeType: mimeType as string },
        text: Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            key === form.dataKey ? stand : entry,
          ]),
        ),
      };
    }
    case "resource-link": {
      if (!isRecord(value)) return undefined;
      const uri = linkUri(ownValue(value, "uri"));
      const name = ownValue(value, "name");
      const mimeType = ownValue(value, "mimeType");
      if (uri === undefined || !isLinkName(name) || !isLinkMimeType(mimeType)) {
        return undefined;
      }
      return {
        block: {
          type: "resource_link",
          uri,
          name,
          ...(mimeType === undefined ? {} : { mimeType: mimeType as string }),
        },
        text: value,
      };
    }
  }
}

function mapValue(
  form: ContentForm,
  value: unknown,
  contentIndex: number,
  protocolVersion: string,
): MappedValue | undefined {
  const mapped = mapForm(form, value, contentIndex);
  return mapped !== undefined &&
    supportsBlock(mapped.block.type, protocolVersion)
    ? mapped
    : undefined;
}

function countPlannedValues(
  plan: McpToolContentPlan,
  output: JsonRecord,
): number {
  let count = 0;
  for (const { key, list } of plan) {
    if (!Object.hasOwn(output, key)) continue;
    const value = output[key];
    count += list && Array.isArray(value) ? value.length : 1;
    if (count > MAX_TOOL_CONTENT_BLOCKS) break;
  }
  return count;
}

function legacyResult(output: JsonRecord): McpToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

/**
 * Presents one validated output as an MCP tool result. `structuredContent` is
 * always the complete output. Each planned value either becomes one block, and
 * its base64 data is replaced by a placeholder in the text block, or stays in
 * the text block unchanged. Without any block, or with more planned values
 * than the limit, the result is exactly the legacy JSON text fallback.
 */
export function createMcpToolResult(
  plan: McpToolContentPlan,
  output: JsonRecord,
  protocolVersion: string,
): McpToolCallResult {
  if (
    plan.length === 0 ||
    countPlannedValues(plan, output) > MAX_TOOL_CONTENT_BLOCKS
  ) {
    return legacyResult(output);
  }
  const blocks: GeneratedContentBlock[] = [];
  const text = new Map<string, unknown>();
  const map = (form: ContentForm, value: unknown): unknown => {
    const mapped = mapValue(form, value, blocks.length + 1, protocolVersion);
    if (mapped === undefined) return value;
    blocks.push(mapped.block);
    return mapped.text;
  };
  for (const { key, list, form } of plan) {
    if (!Object.hasOwn(output, key)) continue;
    const value = output[key];
    if (!list) {
      text.set(key, map(form, value));
    } else if (Array.isArray(value)) {
      text.set(
        key,
        value.map((item: unknown) => map(form, item)),
      );
    }
  }
  if (blocks.length === 0) return legacyResult(output);
  const textValue = Object.fromEntries(
    Object.entries(output).map(([key, value]) => [
      key,
      text.has(key) ? text.get(key) : value,
    ]),
  );
  return {
    content: [{ type: "text", text: JSON.stringify(textValue) }, ...blocks],
    structuredContent: output,
  };
}
