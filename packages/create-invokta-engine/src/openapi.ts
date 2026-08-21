import { type FileHandle, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { parseDocument } from "yaml";

const maxEntryDocumentBytes = 10_485_760;
const maxLocalDocuments = 64;
const maxDocumentDepth = 64;
const maxParsedNodes = 100_000;
const maxReferenceDepth = 64;
const openApiVersionPattern = /^3\.1\.\d+$/u;
const uriSchemePattern = /^[A-Za-z][A-Za-z\d+.-]*:/u;
const unsupportedReference = Object.freeze({});

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

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const status = await handle.stat();
    if (!status.isFile()) throw new OpenApiImportError("OPENAPI_UNAVAILABLE");
    if (status.size > maximumBytes) {
      throw new OpenApiImportError("OPENAPI_LIMIT_EXCEEDED");
    }

    const buffer = new Uint8Array(maximumBytes + 1);
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
    if (length > maximumBytes) {
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

function assertBoundedJsonValue(
  root: unknown,
  parsedNodeCount: { value: number },
): void {
  const stack: Array<Readonly<{ value: unknown; depth: number }>> = [
    { value: root, depth: 1 },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const { value, depth } = current;
    parsedNodeCount.value += 1;
    if (parsedNodeCount.value > maxParsedNodes) {
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

function parseDocumentValue(
  source: Uint8Array,
  parsedNodeCount: { value: number },
): unknown {
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

  assertBoundedJsonValue(value, parsedNodeCount);
  return value;
}

function assertOpenApiDocument(value: unknown): OpenApiDocument {
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

function isContainedPath(rootDirectory: string, path: string): boolean {
  const pathFromRoot = relative(rootDirectory, path);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function pointerTarget(document: unknown, fragment: string): unknown {
  let decodedFragment: string;
  try {
    decodedFragment = decodeURIComponent(fragment);
  } catch {
    return unsupportedReference;
  }
  if (decodedFragment === "") return document;
  if (!decodedFragment.startsWith("/")) return unsupportedReference;

  let current = document;
  for (const encodedToken of decodedFragment.slice(1).split("/")) {
    if (/~(?:[^01]|$)/u.test(encodedToken)) return unsupportedReference;
    const token = encodedToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return unsupportedReference;
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        return unsupportedReference;
      }
      current = current[index];
      continue;
    }
    if (!isObject(current) || !Object.hasOwn(current, token)) {
      return unsupportedReference;
    }
    current = current[token];
  }
  return current;
}

interface ReferenceResolutionContext {
  readonly rootDirectory: string;
  readonly documents: Map<string, unknown>;
  readonly byteCount: { value: number };
  readonly parsedNodeCount: { value: number };
}

function unsupportedReferenceSyntax(reference: string): boolean {
  const path = reference.split("#", 1)[0] ?? "";
  return (
    reference.indexOf("#") !== reference.lastIndexOf("#") ||
    path.includes("?") ||
    path.includes("\0") ||
    uriSchemePattern.test(path) ||
    isAbsolute(path) ||
    path.startsWith("\\\\")
  );
}

async function loadReferencedDocument(
  context: ReferenceResolutionContext,
  declaringDocumentPath: string,
  encodedPath: string,
): Promise<Readonly<{ path: string; value: unknown }> | undefined> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return undefined;
  }
  if (decodedPath.includes("\0")) return undefined;

  const candidatePath = resolve(dirname(declaringDocumentPath), decodedPath);
  if (!isContainedPath(context.rootDirectory, candidatePath)) return undefined;

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidatePath);
  } catch {
    return undefined;
  }
  if (!isContainedPath(context.rootDirectory, canonicalPath)) return undefined;

  if (context.documents.has(canonicalPath)) {
    return { path: canonicalPath, value: context.documents.get(canonicalPath) };
  }
  if (context.documents.size >= maxLocalDocuments) {
    throw new OpenApiImportError("OPENAPI_LIMIT_EXCEEDED");
  }

  const remainingBytes = maxEntryDocumentBytes - context.byteCount.value;
  let source: Uint8Array;
  try {
    source = await readBoundedRegularFile(canonicalPath, remainingBytes);
  } catch (error) {
    if (
      error instanceof OpenApiImportError &&
      error.code === "OPENAPI_LIMIT_EXCEEDED"
    ) {
      throw error;
    }
    return undefined;
  }
  context.byteCount.value += source.byteLength;
  const value = parseDocumentValue(source, context.parsedNodeCount);
  context.documents.set(canonicalPath, value);
  return { path: canonicalPath, value };
}

async function resolveReferences(
  value: unknown,
  declaringDocumentPath: string,
  context: ReferenceResolutionContext,
  depth: number,
  activeReferences: ReadonlySet<string>,
): Promise<unknown> {
  if (depth > maxReferenceDepth) {
    throw new OpenApiImportError("OPENAPI_LIMIT_EXCEEDED");
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const member of value) {
      result.push(
        await resolveReferences(
          member,
          declaringDocumentPath,
          context,
          depth,
          activeReferences,
        ),
      );
    }
    return result;
  }
  if (!isObject(value)) return value;

  if (typeof value.$ref === "string") {
    const reference = value.$ref;
    if (unsupportedReferenceSyntax(reference)) return unsupportedReference;
    const hashIndex = reference.indexOf("#");
    const encodedPath =
      hashIndex === -1 ? reference : reference.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : reference.slice(hashIndex + 1);
    const targetDocument =
      encodedPath === ""
        ? {
            path: declaringDocumentPath,
            value: context.documents.get(declaringDocumentPath),
          }
        : await loadReferencedDocument(
            context,
            declaringDocumentPath,
            encodedPath,
          );
    if (targetDocument?.value === undefined) return unsupportedReference;

    const target = pointerTarget(targetDocument.value, fragment);
    if (target === unsupportedReference) return unsupportedReference;
    const referenceKey = `${targetDocument.path}#${fragment}`;
    if (activeReferences.has(referenceKey)) return unsupportedReference;
    const nextActiveReferences = new Set(activeReferences);
    nextActiveReferences.add(referenceKey);
    const resolvedTarget = await resolveReferences(
      target,
      targetDocument.path,
      context,
      depth + 1,
      nextActiveReferences,
    );
    if (resolvedTarget === unsupportedReference) return unsupportedReference;

    const siblings = Object.fromEntries(
      Object.entries(value).filter(([name]) => name !== "$ref"),
    );
    if (Object.keys(siblings).length === 0) return resolvedTarget;
    if (!isObject(resolvedTarget)) return unsupportedReference;
    const resolvedSiblings = await resolveReferences(
      siblings,
      declaringDocumentPath,
      context,
      depth,
      activeReferences,
    );
    if (!isObject(resolvedSiblings)) return unsupportedReference;
    return { ...resolvedTarget, ...resolvedSiblings };
  }

  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [name, member] of Object.entries(value)) {
    result[name] = await resolveReferences(
      member,
      declaringDocumentPath,
      context,
      depth,
      activeReferences,
    );
  }
  return result;
}

/** Tests whether resolved OpenAPI data contains an unsupported reference marker. */
export function containsUnsupportedOpenApiReference(value: unknown): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === unsupportedReference) return true;
    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (isObject(current)) {
      pending.push(...Object.values(current));
    }
  }
  return false;
}

/** Loads one strict, byte-bounded local OpenAPI 3.1 entry document. */
export async function loadOpenApiDocument(
  options: LoadOpenApiDocumentOptions,
): Promise<OpenApiDocument> {
  const requestedPath = resolve(options.cwd, options.path);
  let entryPath: string;
  try {
    entryPath = await realpath(requestedPath);
  } catch {
    throw new OpenApiImportError("OPENAPI_UNAVAILABLE");
  }
  const bytes = await readBoundedRegularFile(entryPath, maxEntryDocumentBytes);
  const parsedNodeCount = { value: 0 };
  const rawDocument = assertOpenApiDocument(
    parseDocumentValue(bytes, parsedNodeCount),
  );
  const context: ReferenceResolutionContext = {
    rootDirectory: dirname(entryPath),
    documents: new Map([[entryPath, rawDocument]]),
    byteCount: { value: bytes.byteLength },
    parsedNodeCount,
  };
  return assertOpenApiDocument(
    await resolveReferences(rawDocument, entryPath, context, 0, new Set()),
  );
}
