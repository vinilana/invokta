import { readFile as readFileFromDisk } from "node:fs/promises";
import { join } from "node:path";

import { DeployError } from "./errors.js";

export const deployManifestFileName = "invokta.deploy.json";

export const deployManifestLimits = Object.freeze({
  maxEncodedBytes: 65_536,
  maxEnvironmentNames: 64,
  maxStringScalars: 1_024,
} as const);

export const deployManifestDefaults = Object.freeze({
  baseImage: "node:22-slim",
  expect: "alive",
  port: 3000,
} as const);

export const environmentNamePattern = /^[A-Z_][A-Z0-9_]{0,127}$/;

/**
 * A reason is a stable identifier; its message is fixed text. Neither ever
 * carries a rejected value, so a diagnostic can be logged in full.
 */
export const deployManifestIssueMessages = Object.freeze({
  DOCUMENT_TOO_LARGE: "The manifest exceeds the maximum encoded size.",
  DOCUMENT_NOT_JSON: "The manifest is not valid JSON.",
  DOCUMENT_UNREADABLE: "The manifest could not be read.",
  OBJECT_REQUIRED: "A JSON object is required.",
  UNKNOWN_KEY: "The key is not part of the manifest schema.",
  KEY_REQUIRED: "The key is required.",
  SCHEMA_VERSION_UNSUPPORTED: "The schema version must be the number 1.",
  STRING_REQUIRED: "A string is required.",
  STRING_EMPTY: "The value must not be empty.",
  STRING_TOO_LONG: "The value exceeds the maximum string length.",
  STRING_HAS_NUL: "The value must not contain a NUL character.",
  STRING_HAS_WHITESPACE: "The value must not contain whitespace.",
  ARRAY_REQUIRED: "An array is required.",
  ENTRY_ABSOLUTE: "The entry path must be relative to the project root.",
  ENTRY_ESCAPES_PROJECT: "The entry path must stay inside the project.",
  ENTRY_SEGMENT_EMPTY: "The entry path must not contain an empty segment.",
  ENTRY_EXTENSION_UNSUPPORTED: "The entry path must end in .js or .mjs.",
  ENVIRONMENT_NAME_INVALID: "The environment variable name is not valid.",
  ENVIRONMENT_NAME_DUPLICATE:
    "The environment variable name is already declared.",
  ENVIRONMENT_NAMES_EXCEEDED:
    "The manifest declares too many environment variable names.",
  INTEGER_REQUIRED: "An integer is required.",
  PORT_OUT_OF_RANGE: "The port must be between 1 and 65535.",
  EXPECTATION_UNSUPPORTED: 'The expectation must be "alive" or "ready".',
  BEARER_ENV_NOT_ALLOWED:
    'A bearer variable is allowed only when the expectation is "ready".',
} as const);

export type DeployManifestIssueReason =
  keyof typeof deployManifestIssueMessages;

export interface DeployManifestIssue {
  /** RFC 6901 JSON pointer; the empty string addresses the whole document. */
  readonly pointer: string;
  readonly reason: DeployManifestIssueReason;
}

export interface DeployManifestEnvironment {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export interface DeployManifestImage {
  readonly baseImage: string;
  readonly port: number;
}

export interface DeployManifestHealthcheck {
  readonly expect: "alive" | "ready";
  readonly bearerEnv?: string;
}

/** A validated manifest with every documented default already applied. */
export interface HttpDeployManifest {
  readonly schemaVersion: 1;
  readonly entry: string;
  readonly env: DeployManifestEnvironment;
  readonly image: DeployManifestImage;
  readonly healthcheck: DeployManifestHealthcheck;
}

export interface DeployManifestSuccess {
  readonly ok: true;
  readonly manifest: HttpDeployManifest;
}

export interface DeployManifestFailure {
  readonly ok: false;
  readonly code: "MANIFEST_NOT_FOUND" | "MANIFEST_INVALID";
  readonly issues: readonly DeployManifestIssue[];
}

export type DeployManifestResult =
  | DeployManifestSuccess
  | DeployManifestFailure;

export interface LoadDeployManifestOptions {
  readonly cwd: string;
  /** Defaults to reading the manifest from disk as UTF-8. */
  readonly readFile?: (path: string) => Promise<string>;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

type AddIssue = (
  pointer: string,
  reason: DeployManifestIssueReason,
) => undefined;

interface StringOptions {
  readonly allowEmpty?: boolean;
  readonly rejectWhitespace?: boolean;
}

const encoder = new TextEncoder();
const rootKeys = ["schemaVersion", "entry", "env", "image", "healthcheck"];
const environmentKeys = ["required", "optional"];
const imageKeys = ["baseImage", "port"];
const healthcheckKeys = ["expect", "bearerEnv"];
const entrySeparator = /[\\/]/u;
const whitespace = /\s/u;
const windowsDrive = /^[A-Za-z]:/u;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointer(...segments: readonly (string | number)[]): string {
  return segments
    .map((segment) => `/${escapeSegment(String(segment))}`)
    .join("");
}

function countScalars(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

function compareIssues(
  left: DeployManifestIssue,
  right: DeployManifestIssue,
): number {
  if (left.pointer !== right.pointer) {
    return left.pointer < right.pointer ? -1 : 1;
  }
  if (left.reason === right.reason) return 0;
  return left.reason < right.reason ? -1 : 1;
}

function failure(
  code: DeployManifestFailure["code"],
  issues: readonly DeployManifestIssue[],
): DeployManifestFailure {
  return Object.freeze({
    ok: false,
    code,
    issues: Object.freeze([...issues].sort(compareIssues)),
  });
}

function rejectUnknownKeys(
  value: UnknownRecord,
  known: readonly string[],
  parent: string,
  add: AddIssue,
): undefined {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) add(`${parent}${pointer(key)}`, "UNKNOWN_KEY");
  }
  return undefined;
}

/**
 * Applies every bound that holds for any manifest string. The first failing
 * check wins, so one rejected value never produces two issues.
 */
function validateString(
  value: unknown,
  at: string,
  add: AddIssue,
  options: StringOptions = {},
): string | undefined {
  if (typeof value !== "string") return add(at, "STRING_REQUIRED");
  if (value.includes("\u0000")) return add(at, "STRING_HAS_NUL");
  if (countScalars(value) > deployManifestLimits.maxStringScalars) {
    return add(at, "STRING_TOO_LONG");
  }
  if (value === "" && options.allowEmpty !== true) {
    return add(at, "STRING_EMPTY");
  }
  if (options.rejectWhitespace === true && whitespace.test(value)) {
    return add(at, "STRING_HAS_WHITESPACE");
  }
  return value;
}

function validateEntry(value: unknown, add: AddIssue): string | undefined {
  const at = pointer("entry");
  const entry = validateString(value, at, add);
  if (entry === undefined) return undefined;

  if (
    entry.startsWith("/") ||
    entry.startsWith("\\") ||
    windowsDrive.test(entry)
  ) {
    return add(at, "ENTRY_ABSOLUTE");
  }
  const segments = entry.split(entrySeparator);
  if (segments.includes("")) return add(at, "ENTRY_SEGMENT_EMPTY");
  if (segments.includes("..")) return add(at, "ENTRY_ESCAPES_PROJECT");
  if (!entry.endsWith(".js") && !entry.endsWith(".mjs")) {
    return add(at, "ENTRY_EXTENSION_UNSUPPORTED");
  }
  return entry;
}

function validateEnvironmentName(
  value: unknown,
  at: string,
  add: AddIssue,
  declared: Set<string>,
): string | undefined {
  const name = validateString(value, at, add, { allowEmpty: true });
  if (name === undefined) return undefined;
  if (!environmentNamePattern.test(name)) {
    return add(at, "ENVIRONMENT_NAME_INVALID");
  }
  if (declared.has(name)) return add(at, "ENVIRONMENT_NAME_DUPLICATE");
  declared.add(name);
  return name;
}

function validateNameList(
  value: unknown,
  key: string,
  add: AddIssue,
  declared: Set<string>,
): { readonly names: readonly string[]; readonly declaredCount: number } {
  const at = `${pointer("env")}${pointer(key)}`;
  if (value === undefined) return { names: [], declaredCount: 0 };
  if (!Array.isArray(value)) {
    add(at, "ARRAY_REQUIRED");
    return { names: [], declaredCount: 0 };
  }
  const names: string[] = [];
  for (const [index, item] of value.entries()) {
    const name = validateEnvironmentName(
      item,
      `${at}${pointer(index)}`,
      add,
      declared,
    );
    if (name !== undefined) names.push(name);
  }
  return { names, declaredCount: value.length };
}

function validateEnvironment(
  value: unknown,
  add: AddIssue,
): DeployManifestEnvironment {
  const empty = { required: [], optional: [] };
  if (value === undefined) return empty;
  const at = pointer("env");
  if (!isRecord(value)) {
    add(at, "OBJECT_REQUIRED");
    return empty;
  }
  rejectUnknownKeys(value, environmentKeys, at, add);

  const declared = new Set<string>();
  const required = validateNameList(value.required, "required", add, declared);
  const optional = validateNameList(value.optional, "optional", add, declared);
  if (
    required.declaredCount + optional.declaredCount >
    deployManifestLimits.maxEnvironmentNames
  ) {
    add(at, "ENVIRONMENT_NAMES_EXCEEDED");
  }
  return { required: required.names, optional: optional.names };
}

function validateImage(value: unknown, add: AddIssue): DeployManifestImage {
  const defaults: DeployManifestImage = {
    baseImage: deployManifestDefaults.baseImage,
    port: deployManifestDefaults.port,
  };
  if (value === undefined) return defaults;
  const at = pointer("image");
  if (!isRecord(value)) {
    add(at, "OBJECT_REQUIRED");
    return defaults;
  }
  rejectUnknownKeys(value, imageKeys, at, add);

  // The Node.js major version of the tag is not inspected: the toolkit never
  // pulls the image, and tag conventions differ across registries.
  const baseImage =
    value.baseImage === undefined
      ? defaults.baseImage
      : validateString(value.baseImage, `${at}${pointer("baseImage")}`, add, {
          rejectWhitespace: true,
        });

  let port = defaults.port;
  if (value.port !== undefined) {
    const portAt = `${at}${pointer("port")}`;
    if (typeof value.port !== "number" || !Number.isInteger(value.port)) {
      add(portAt, "INTEGER_REQUIRED");
    } else if (value.port < 1 || value.port > 65_535) {
      add(portAt, "PORT_OUT_OF_RANGE");
    } else {
      port = value.port;
    }
  }
  return { baseImage: baseImage ?? defaults.baseImage, port };
}

function validateHealthcheck(
  value: unknown,
  add: AddIssue,
): DeployManifestHealthcheck {
  const defaults = { expect: deployManifestDefaults.expect };
  if (value === undefined) return defaults;
  const at = pointer("healthcheck");
  if (!isRecord(value)) {
    add(at, "OBJECT_REQUIRED");
    return defaults;
  }
  rejectUnknownKeys(value, healthcheckKeys, at, add);

  let expectation: "alive" | "ready" = defaults.expect;
  if (value.expect !== undefined) {
    const expectAt = `${at}${pointer("expect")}`;
    const declared = validateString(value.expect, expectAt, add, {
      allowEmpty: true,
    });
    if (declared !== undefined) {
      if (declared === "alive" || declared === "ready") {
        expectation = declared;
      } else {
        add(expectAt, "EXPECTATION_UNSUPPORTED");
      }
    }
  }

  if (value.bearerEnv === undefined) return { expect: expectation };
  const bearerAt = `${at}${pointer("bearerEnv")}`;
  if (expectation !== "ready") {
    add(bearerAt, "BEARER_ENV_NOT_ALLOWED");
    return { expect: expectation };
  }
  const bearerEnv = validateEnvironmentName(
    value.bearerEnv,
    bearerAt,
    add,
    new Set(),
  );
  return bearerEnv === undefined
    ? { expect: expectation }
    : { expect: expectation, bearerEnv };
}

/**
 * Validates one manifest document and reports every detectable issue in
 * deterministic JSON-pointer order. A rejected value is never echoed.
 */
export function parseDeployManifest(text: string): DeployManifestResult {
  if (encoder.encode(text).length > deployManifestLimits.maxEncodedBytes) {
    return failure("MANIFEST_INVALID", [
      { pointer: "", reason: "DOCUMENT_TOO_LARGE" },
    ]);
  }

  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    return failure("MANIFEST_INVALID", [
      { pointer: "", reason: "DOCUMENT_NOT_JSON" },
    ]);
  }
  if (!isRecord(document)) {
    return failure("MANIFEST_INVALID", [
      { pointer: "", reason: "OBJECT_REQUIRED" },
    ]);
  }

  // An unsupported schema version is reported alone: no other schema is known
  // to apply, so every further diagnostic would be about the wrong contract.
  const schemaVersionAt = pointer("schemaVersion");
  if (!Object.hasOwn(document, "schemaVersion")) {
    return failure("MANIFEST_INVALID", [
      { pointer: schemaVersionAt, reason: "KEY_REQUIRED" },
    ]);
  }
  if (document.schemaVersion !== 1) {
    return failure("MANIFEST_INVALID", [
      { pointer: schemaVersionAt, reason: "SCHEMA_VERSION_UNSUPPORTED" },
    ]);
  }

  const issues: DeployManifestIssue[] = [];
  const add: AddIssue = (at, reason) => {
    issues.push({ pointer: at, reason });
    return undefined;
  };

  rejectUnknownKeys(document, rootKeys, "", add);
  const entry = Object.hasOwn(document, "entry")
    ? validateEntry(document.entry, add)
    : add(pointer("entry"), "KEY_REQUIRED");
  const env = validateEnvironment(document.env, add);
  const image = validateImage(document.image, add);
  const healthcheck = validateHealthcheck(document.healthcheck, add);

  if (issues.length > 0 || entry === undefined) {
    return failure("MANIFEST_INVALID", issues);
  }
  return Object.freeze({
    ok: true,
    manifest: Object.freeze({
      schemaVersion: 1,
      entry,
      env: Object.freeze({
        required: Object.freeze([...env.required]),
        optional: Object.freeze([...env.optional]),
      }),
      image: Object.freeze({ ...image }),
      healthcheck: Object.freeze({ ...healthcheck }),
    }),
  });
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Loads and validates the manifest at the project root. A read failure is
 * classified without echoing the underlying system message.
 */
export async function loadDeployManifest(
  options: LoadDeployManifestOptions,
): Promise<DeployManifestResult> {
  const path = join(options.cwd, deployManifestFileName);
  const read =
    options.readFile ?? ((target: string) => readFileFromDisk(target, "utf8"));

  let text: string;
  try {
    text = await read(path);
  } catch (error) {
    const code = readErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return failure("MANIFEST_NOT_FOUND", []);
    }
    return failure("MANIFEST_INVALID", [
      { pointer: "", reason: "DOCUMENT_UNREADABLE" },
    ]);
  }
  return parseDeployManifest(text);
}

/**
 * Converts a rejected manifest into the toolkit error a command reports. The
 * pointer is emitted as a JSON string literal so a crafted key cannot forge an
 * additional diagnostic line.
 */
export function toDeployError(result: DeployManifestFailure): DeployError {
  return new DeployError(result.code, {
    details: result.issues.map(
      (issue) =>
        `${JSON.stringify(issue.pointer)}: ${deployManifestIssueMessages[issue.reason]}`,
    ),
  });
}
