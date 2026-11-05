import type { EngineJsonSchema } from "@invokta/core";

/**
 * Maps annotated top-level output properties to MCP image, audio, and
 * resource-link content blocks (ADR 0044). The plan is derived once per tool
 * from the captured output JSON Schema; the result mapping is a pure function
 * of that plan and the validated output, so stdio and HTTP present the same
 * capability result identically.
 */

/** Content blocks generated for one result, besides the JSON text block. */
export const MAX_TOOL_CONTENT_BLOCKS = 16;

const MAX_LINK_URI_BYTES = 8_192;
const MAX_LINK_NAME_BYTES = 1_024;

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
const LINK_PROPERTIES: ReadonlySet<string> = new Set([
  "uri",
  "name",
  "mimeType",
]);
// RFC 6838 restricted names, without parameters.
const MEDIA_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u;

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

// Type aliases rather than interfaces, so results satisfy the SDK's indexed
// result type without importing it here.
export type McpToolCallResult = {
  readonly content: Array<TextContentBlock | GeneratedContentBlock>;
  readonly structuredContent: JsonRecord;
};

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

function declaredMediaTypes(schema: unknown): ReadonlySet<string> | undefined {
  if (!isStringSchema(schema)) return undefined;
  const enumValues = ownValue(schema, "enum");
  const values = [
    ...(Object.hasOwn(schema, "const") ? [ownValue(schema, "const")] : []),
    ...(Array.isArray(enumValues) ? enumValues : []),
  ];
  if (values.length === 0) return undefined;
  if (!values.every((value) => mediaBlockType(value) !== undefined)) {
    return undefined;
  }
  return new Set(values as string[]);
}

function isResourceLinkSchema(properties: JsonRecord): boolean {
  const uri = ownValue(properties, "uri");
  return (
    Object.keys(properties).every((key) => LINK_PROPERTIES.has(key)) &&
    isStringSchema(uri) &&
    ownValue(uri, "format") === "uri" &&
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
  const dataKeys = Object.keys(properties).filter(
    (key) => key !== "mimeType" && isBase64StringSchema(properties[key]),
  );
  const [dataKey] = dataKeys;
  return dataKeys.length === 1 && dataKey !== undefined
    ? { kind: "media-object", dataKey, mimeTypes }
    : undefined;
}

/** Derives the content plan of one tool from its output JSON Schema. */
export function planMcpToolContent(
  outputSchema: EngineJsonSchema,
): McpToolContentPlan {
  const properties = ownValue(outputSchema, "properties");
  if (ownValue(outputSchema, "type") !== "object" || !isRecord(properties)) {
    return Object.freeze([]);
  }
  const plan: PlannedProperty[] = [];
  for (const key of Object.keys(properties)) {
    const schema = properties[key];
    const isList = isRecord(schema) && ownValue(schema, "type") === "array";
    const form = recognizeForm(
      isList ? ownValue(schema as JsonRecord, "items") : schema,
    );
    if (form !== undefined) {
      plan.push(Object.freeze({ key, list: isList, form }));
    }
  }
  return Object.freeze(plan);
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isLinkUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_LINK_URI_BYTES) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // Printable ASCII only, so the UTF-16 length is the UTF-8 byte length.
    if (code < 0x21 || code > 0x7e) return false;
  }
  if (!value.startsWith("https://") && !value.startsWith("http://")) {
    return false;
  }
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.username === "" && url.password === "" && url.hostname !== "";
}

interface MappedValue {
  readonly block: GeneratedContentBlock;
  /** The value for the text block; `undefined` removes it. */
  readonly text: unknown;
}

function mapValue(form: ContentForm, value: unknown): MappedValue | undefined {
  switch (form.kind) {
    case "media": {
      const type = mediaBlockType(form.mimeType);
      if (type === undefined || !isBase64(value)) return undefined;
      return {
        block: { type, data: value, mimeType: form.mimeType },
        text: undefined,
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
      return {
        block: { type, data, mimeType: mimeType as string },
        text: Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== form.dataKey),
        ),
      };
    }
    case "resource-link": {
      if (!isRecord(value)) return undefined;
      const uri = ownValue(value, "uri");
      const name = ownValue(value, "name");
      const mimeType = ownValue(value, "mimeType");
      if (
        !isLinkUri(uri) ||
        typeof name !== "string" ||
        name.length === 0 ||
        utf8Bytes(name) > MAX_LINK_NAME_BYTES ||
        (mimeType !== undefined &&
          (typeof mimeType !== "string" || !MEDIA_TYPE_PATTERN.test(mimeType)))
      ) {
        return undefined;
      }
      return {
        block: {
          type: "resource_link",
          uri,
          name,
          ...(mimeType === undefined ? {} : { mimeType }),
        },
        text: value,
      };
    }
  }
}

/**
 * Returns the generated blocks and the text value, or `undefined` when the
 * result must keep the legacy presentation: no planned value is present, a
 * planned value is invalid, or the block limit would be exceeded.
 */
function mapResult(
  plan: McpToolContentPlan,
  output: JsonRecord,
):
  | {
      readonly blocks: GeneratedContentBlock[];
      readonly text: Map<string, unknown>;
    }
  | undefined {
  const blocks: GeneratedContentBlock[] = [];
  const text = new Map<string, unknown>();
  for (const { key, list, form } of plan) {
    if (!Object.hasOwn(output, key)) continue;
    const value = output[key];
    if (!list) {
      if (blocks.length >= MAX_TOOL_CONTENT_BLOCKS) return undefined;
      const mapped = mapValue(form, value);
      if (mapped === undefined) return undefined;
      blocks.push(mapped.block);
      text.set(key, mapped.text);
      continue;
    }
    if (!Array.isArray(value)) return undefined;
    if (value.length === 0) continue;
    if (blocks.length + value.length > MAX_TOOL_CONTENT_BLOCKS) {
      return undefined;
    }
    const items: unknown[] = [];
    for (const item of value) {
      const mapped = mapValue(form, item);
      if (mapped === undefined) return undefined;
      blocks.push(mapped.block);
      items.push(mapped.text);
    }
    text.set(key, form.kind === "media" ? undefined : items);
  }
  return blocks.length === 0 ? undefined : { blocks, text };
}

/**
 * Presents one validated output as an MCP tool result. `structuredContent` is
 * always the complete output. Without generated blocks, the result is exactly
 * the legacy JSON text fallback; with them, the text block omits every base64
 * value that a block already carries.
 */
export function createMcpToolResult(
  plan: McpToolContentPlan,
  output: JsonRecord,
): McpToolCallResult {
  const mapped = plan.length === 0 ? undefined : mapResult(plan, output);
  if (mapped === undefined) {
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }
  const textValue = Object.fromEntries(
    Object.entries(output).flatMap(([key, value]): [string, unknown][] => {
      if (!mapped.text.has(key)) return [[key, value]];
      const replacement = mapped.text.get(key);
      return replacement === undefined ? [] : [[key, replacement]];
    }),
  );
  return {
    content: [
      { type: "text", text: JSON.stringify(textValue) },
      ...mapped.blocks,
    ],
    structuredContent: output,
  };
}
