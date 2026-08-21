import { type FileHandle, open } from "node:fs/promises";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

const maxEntryDocumentBytes = 10_485_760;
const maxDocumentDepth = 64;
const maxParsedNodes = 100_000;
const openApiVersionPattern = /^3\.1\.\d+$/u;

export type OpenApiObject = Readonly<Record<string, unknown>>;

export interface OpenApiDocument extends OpenApiObject {
  readonly openapi: string;
  readonly info: OpenApiObject;
  readonly paths: OpenApiObject;
}

export type OpenApiImportErrorCode =
  | "OPENAPI_INVALID"
  | "OPENAPI_UNAVAILABLE"
  | "OPENAPI_UNSUPPORTED"
  | "OPENAPI_LIMIT_EXCEEDED"
  | "OPENAPI_SELECTION_INVALID";

const errorExitCodes = Object.freeze({
  OPENAPI_INVALID: 2,
  OPENAPI_UNAVAILABLE: 1,
  OPENAPI_UNSUPPORTED: 1,
  OPENAPI_LIMIT_EXCEEDED: 1,
  OPENAPI_SELECTION_INVALID: 2,
} as const satisfies Readonly<Record<OpenApiImportErrorCode, 1 | 2>>);

/** A payload-free failure at the local OpenAPI import boundary. */
export class OpenApiImportError extends Error {
  readonly code: OpenApiImportErrorCode;
  readonly exitCode: 1 | 2;

  constructor(code: OpenApiImportErrorCode) {
    super(code);
    this.name = "OpenApiImportError";
    this.code = code;
    this.exitCode = errorExitCodes[code];
  }
}

export interface LoadOpenApiDocumentOptions {
  readonly cwd: string;
  readonly path: string;
}

function isObject(value: unknown): value is OpenApiObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

async function readBoundedRegularFile(path: string): Promise<Uint8Array> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const status = await handle.stat();
    if (!status.isFile()) throw new OpenApiImportError("OPENAPI_UNAVAILABLE");
    if (status.size > maxEntryDocumentBytes) {
      throw new OpenApiImportError("OPENAPI_LIMIT_EXCEEDED");
    }

    const buffer = new Uint8Array(maxEntryDocumentBytes + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        length,
        buffer.byteLength - length,
        length,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maxEntryDocumentBytes) {
      throw new OpenApiImportError("OPENAPI_LIMIT_EXCEEDED");
    }
    return buffer.slice(0, length);
  } catch (error) {
    if (error instanceof OpenApiImportError) throw error;
    throw new OpenApiImportError("OPENAPI_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertBoundedJsonValue(root: unknown): void {
  const stack: Array<Readonly<{ value: unknown; depth: number }>> = [
    { value: root, depth: 1 },
  ];
  let parsedNodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const { value, depth } = current;
    parsedNodes += 1;
    if (parsedNodes > maxParsedNodes) {
      throw new OpenApiImportError("OPENAPI_LIMIT_EXCEEDED");
    }
    if (depth > maxDocumentDepth) {
      throw new OpenApiImportError("OPENAPI_LIMIT_EXCEEDED");
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new OpenApiImportError("OPENAPI_INVALID");
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: depth + 1 });
      }
      continue;
    }
    if (!isObject(value)) {
      throw new OpenApiImportError("OPENAPI_INVALID");
    }
    for (const member of Object.values(value)) {
      stack.push({ value: member, depth: depth + 1 });
    }
  }
}

function parseOpenApiDocument(source: Uint8Array): OpenApiDocument {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new OpenApiImportError("OPENAPI_INVALID");
  }

  let value: unknown;
  try {
    const document = parseDocument(text, {
      merge: false,
      schema: "json",
      uniqueKeys: true,
    });
    const hasNonPlainScalarError = document.errors.some(
      (error) => error.code !== "TAG_RESOLVE_FAILED",
    );
    if (hasNonPlainScalarError || document.warnings.length > 0) {
      throw new OpenApiImportError("OPENAPI_INVALID");
    }
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof OpenApiImportError) throw error;
    throw new OpenApiImportError("OPENAPI_INVALID");
  }

  assertBoundedJsonValue(value);
  if (!isObject(value)) throw new OpenApiImportError("OPENAPI_INVALID");
  if (
    typeof value.openapi !== "string" ||
    !openApiVersionPattern.test(value.openapi) ||
    !isObject(value.info) ||
    typeof value.info.title !== "string" ||
    value.info.title === "" ||
    typeof value.info.version !== "string" ||
    value.info.version === "" ||
    !isObject(value.paths)
  ) {
    throw new OpenApiImportError("OPENAPI_INVALID");
  }
  return value as OpenApiDocument;
}

/** Loads one strict, byte-bounded local OpenAPI 3.1 entry document. */
export async function loadOpenApiDocument(
  options: LoadOpenApiDocumentOptions,
): Promise<OpenApiDocument> {
  const bytes = await readBoundedRegularFile(
    resolve(options.cwd, options.path),
  );
  return parseOpenApiDocument(bytes);
}
