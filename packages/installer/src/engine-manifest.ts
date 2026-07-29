import { isAbsolute, join, resolve } from "node:path";
import { evaluate, parse, type ValueNode } from "@humanwhocodes/momoa";

import {
  type InstallerFileStat,
  type InstallerReadHandle,
  type InstallerTransactionFileSystem,
  isInstallerFileSystemError,
} from "./file-system.js";
import { InstallerError } from "./installer-error.js";
import {
  capturePathIdentity,
  capturePathRoot,
  type InstallerPathIdentity,
  type InstallerPathRootIdentity,
} from "./path-identity.js";
import type { CapabilityInstallDescriptor } from "./registry.js";

const manifestByteLimit = 1_048_576;
const generalStringLimit = 4_096;
const entrypointScalarLimit = 1_024;
const entrypointSegmentLimit = 32;
const idPattern = /^[a-z][a-z0-9-]{0,127}$/u;
const serverNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const environmentNamePattern = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const rootKeys = new Set([
  "schemaVersion",
  "id",
  "version",
  "title",
  "description",
  "capabilityIds",
  "server",
]);
const serverKeys = new Set(["name", "entrypoint", "forwardEnv"]);

type JsonRecord = Record<string, unknown>;

interface ValidatedEngineManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly capabilityIds: readonly string[];
  readonly server: {
    readonly name: string;
    readonly entrypoint: string;
    readonly forwardEnv: readonly string[];
  };
}

export interface LoadEngineInstallManifestOptions {
  readonly currentUserId: number;
  readonly fileSystem: InstallerTransactionFileSystem;
  readonly nodeExecutable: string;
  readonly projectDirectory: string;
}

export interface EngineInstallSource {
  readonly manifestPath: string;
  readonly entrypointPath: string;
  readonly descriptor: CapabilityInstallDescriptor;
}

function manifestInvalid(cause?: unknown): never {
  throw new InstallerError("ENGINE_MANIFEST_INVALID", cause);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function scalarLength(value: string): number | undefined {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return undefined;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return undefined;
    }
    count += 1;
  }
  return count;
}

function validString(
  value: unknown,
  options: { readonly limit?: number; readonly nonempty?: boolean } = {},
): value is string {
  if (typeof value !== "string" || value.includes("\0")) return false;
  const length = scalarLength(value);
  if (length === undefined || length > (options.limit ?? generalStringLimit)) {
    return false;
  }
  return options.nonempty !== true || value.trim() !== "";
}

function validUniqueStringArray(
  value: unknown,
  options: {
    readonly maximum: number;
    readonly minimum?: number;
    readonly environmentNames?: boolean;
  },
): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length < (options.minimum ?? 0) ||
    value.length > options.maximum
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (!validString(item, { nonempty: true }) || seen.has(item)) return false;
    if (
      options.environmentNames === true &&
      !environmentNamePattern.test(item)
    ) {
      return false;
    }
    seen.add(item);
  }
  return true;
}

function validEntrypoint(value: unknown): value is string {
  if (
    !validString(value, { limit: entrypointScalarLimit, nonempty: true }) ||
    value.startsWith("/") ||
    value.includes("\\")
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.length <= entrypointSegmentLimit &&
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    )
  );
}

function hasDuplicateObjectKey(node: ValueNode): boolean {
  if (node.type === "Object") {
    const names = new Set<string>();
    for (const member of node.members) {
      const name =
        member.name.type === "String" ? member.name.value : member.name.name;
      if (names.has(name) || hasDuplicateObjectKey(member.value)) return true;
      names.add(name);
    }
  } else if (node.type === "Array") {
    return node.elements.some((element) =>
      hasDuplicateObjectKey(element.value),
    );
  }
  return false;
}

function validateParsedManifest(value: unknown): ValidatedEngineManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, rootKeys, [
      "schemaVersion",
      "id",
      "version",
      "title",
      "description",
      "capabilityIds",
      "server",
    ]) ||
    value.schemaVersion !== 1 ||
    !validString(value.id) ||
    !idPattern.test(value.id) ||
    !validString(value.version, { nonempty: true }) ||
    !validString(value.title, { limit: 120, nonempty: true }) ||
    !validString(value.description, { limit: 1_000, nonempty: true }) ||
    !validUniqueStringArray(value.capabilityIds, {
      maximum: 100,
      minimum: 1,
    }) ||
    !isRecord(value.server) ||
    !hasExactKeys(value.server, serverKeys, [
      "name",
      "entrypoint",
      "forwardEnv",
    ]) ||
    !validString(value.server.name) ||
    !serverNamePattern.test(value.server.name) ||
    !validEntrypoint(value.server.entrypoint) ||
    !validUniqueStringArray(value.server.forwardEnv, {
      maximum: 64,
      environmentNames: true,
    })
  ) {
    return manifestInvalid();
  }

  return Object.freeze({
    schemaVersion: 1,
    id: value.id,
    version: value.version,
    title: value.title,
    description: value.description,
    capabilityIds: Object.freeze([...value.capabilityIds]),
    server: Object.freeze({
      name: value.server.name,
      entrypoint: value.server.entrypoint,
      forwardEnv: Object.freeze([...value.server.forwardEnv]),
    }),
  });
}

export function validateEngineInstallManifestBytes(
  bytes: Uint8Array,
): ValidatedEngineManifest {
  if (
    bytes.byteLength > manifestByteLimit ||
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    return manifestInvalid();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause) {
    return manifestInvalid(cause);
  }

  try {
    const document = parse(text, { mode: "json" });
    if (hasDuplicateObjectKey(document.body)) return manifestInvalid();
    return validateParsedManifest(evaluate(document));
  } catch (cause) {
    if (cause instanceof InstallerError) throw cause;
    return manifestInvalid(cause);
  }
}

function sameStat(
  expected: InstallerFileStat | undefined,
  actual: InstallerFileStat,
): boolean {
  return (
    expected !== undefined &&
    expected.kind === actual.kind &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.uid === actual.uid &&
    expected.gid === actual.gid
  );
}

async function readCapturedManifest(
  fileSystem: InstallerTransactionFileSystem,
  identity: InstallerPathIdentity,
): Promise<Uint8Array> {
  let handle: InstallerReadHandle | undefined;
  try {
    handle = await fileSystem.openReadNoFollow(identity.targetPath);
    const stat = await handle.stat();
    if (!sameStat(identity.components.at(-1), stat)) {
      throw new InstallerError("ENGINE_PATH_UNSAFE");
    }
    return await handle.readAll(manifestByteLimit);
  } catch (cause) {
    if (cause instanceof InstallerError) throw cause;
    if (isInstallerFileSystemError(cause, "SYMBOLIC_LINK")) {
      throw new InstallerError("ENGINE_PATH_UNSAFE", cause);
    }
    throw new InstallerError("ENGINE_MANIFEST_INVALID", cause);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function loadEngineInstallManifest(
  options: LoadEngineInstallManifestOptions,
): Promise<EngineInstallSource> {
  if (
    !Number.isSafeInteger(options.currentUserId) ||
    options.currentUserId < 0 ||
    !isAbsolute(options.nodeExecutable) ||
    options.nodeExecutable.includes("\0") ||
    !isAbsolute(resolve(options.projectDirectory)) ||
    options.projectDirectory.includes("\0")
  ) {
    throw new InstallerError("ENGINE_PATH_UNSAFE");
  }
  const projectDirectory = resolve(options.projectDirectory);
  let root: InstallerPathRootIdentity;
  let manifestIdentity: InstallerPathIdentity;
  try {
    root = await capturePathRoot(options.fileSystem, {
      rootKind: "engine",
      rootPath: projectDirectory,
      currentUserId: options.currentUserId,
    });
    manifestIdentity = await capturePathIdentity(options.fileSystem, {
      root,
      targetPath: join(projectDirectory, "invokta.mcp.json"),
      targetKind: "regular-file",
    });
  } catch (cause) {
    throw new InstallerError("ENGINE_PATH_UNSAFE", cause);
  }
  if (manifestIdentity.missingPaths.length > 0) {
    throw new InstallerError("ENGINE_MANIFEST_INVALID");
  }
  const manifest = validateEngineInstallManifestBytes(
    await readCapturedManifest(options.fileSystem, manifestIdentity),
  );
  const entrypointPath = join(
    projectDirectory,
    ...manifest.server.entrypoint.split("/"),
  );
  let entrypointIdentity: InstallerPathIdentity;
  try {
    entrypointIdentity = await capturePathIdentity(options.fileSystem, {
      root,
      targetPath: entrypointPath,
      targetKind: "regular-file",
    });
  } catch (cause) {
    throw new InstallerError("ENGINE_PATH_UNSAFE", cause);
  }
  if (entrypointIdentity.missingPaths.length > 0) {
    throw new InstallerError("ENGINE_ENTRYPOINT_MISSING");
  }

  const transport = Object.freeze({
    type: "stdio" as const,
    command: options.nodeExecutable,
    args: Object.freeze([entrypointPath]),
    forwardEnv: manifest.server.forwardEnv,
  });
  const descriptor: CapabilityInstallDescriptor = Object.freeze({
    id: manifest.id,
    version: manifest.version,
    title: manifest.title,
    description: manifest.description,
    capabilityIds: manifest.capabilityIds,
    server: Object.freeze({ name: manifest.server.name, transport }),
  });
  return Object.freeze({
    manifestPath: manifestIdentity.targetPath,
    entrypointPath,
    descriptor,
  });
}
