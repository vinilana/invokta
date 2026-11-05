import type {
  CapabilityAccessKind,
  CapabilityAnnotations,
  CapabilityDeprecation,
  CapabilityMap,
  Engine,
  EngineJsonSchema,
} from "@invokta/core";

import { quoteIdentifier } from "./contract-text.js";

/** One declared domain error, keyed by its code in the snapshot. */
export interface ContractErrorSnapshot {
  readonly description: string;
  readonly retryable: boolean;
  readonly detailsSchema?: EngineJsonSchema;
}

/** The public contract of one capability as recorded in a snapshot. */
export interface ContractCapabilitySnapshot {
  readonly title?: string;
  readonly description: string;
  readonly access: CapabilityAccessKind;
  readonly timeoutMs?: number;
  readonly annotations?: CapabilityAnnotations;
  readonly deprecated?: CapabilityDeprecation;
  readonly inputSchema: EngineJsonSchema;
  readonly outputSchema: EngineJsonSchema;
  /** Declared domain errors keyed by code; absent when none is declared. */
  readonly errors?: Readonly<Record<string, ContractErrorSnapshot>>;
}

/** A deterministic record of an engine's public contract for CI comparison. */
export interface ContractSnapshot {
  readonly formatVersion: 1;
  readonly engine: { readonly name: string; readonly version: string };
  readonly capabilities: Readonly<Record<string, ContractCapabilitySnapshot>>;
}

/** Largest snapshot document, in bytes, that the tooling writes or reads. */
export const maximumSnapshotBytes = 16 * 1024 * 1024;
/** Deepest JSON nesting accepted inside one schema document. */
export const maximumSchemaDepth = 256;

const accessKinds: readonly CapabilityAccessKind[] = [
  "public",
  "authenticated",
  "function",
];
const annotationKeys = [
  "readOnly",
  "destructive",
  "idempotent",
  "openWorld",
] as const;
const deprecationKeys = ["reason", "since", "replacement"] as const;
const rootKeys = ["formatVersion", "engine", "capabilities"] as const;
const engineKeys = ["name", "version"] as const;
const capabilityKeys = [
  "title",
  "description",
  "access",
  "timeoutMs",
  "annotations",
  "deprecated",
  "inputSchema",
  "outputSchema",
  "errors",
] as const;
const errorKeys = ["description", "retryable", "detailsSchema"] as const;

type UnknownRecord = Readonly<Record<string, unknown>>;

/** A snapshot document that does not satisfy the published format. */
export class ContractSnapshotError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ContractSnapshotError";
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(record: UnknownRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function fail(message: string): never {
  throw new ContractSnapshotError(message);
}

function expectRecord(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) fail(`${path} must be a JSON object.`);
  return value;
}

function expectOnlyKeys(
  record: UnknownRecord,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record).sort(compareCodeUnits)) {
    if (!allowed.includes(key)) {
      fail(`${path} contains the unsupported field ${quoteIdentifier(key)}.`);
    }
  }
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} must be a string.`);
  return value;
}

function childPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * How a JSON value is interpreted while it is canonicalized. Inside a schema,
 * set-valued keywords are sorted; inside data (`const`, `default`, `examples`,
 * `enum` members) only object keys are sorted, because array order is data.
 * A schema map (`properties`, `$defs`, ...) holds schemas under arbitrary
 * names, so a property named `enum` is still a schema.
 */
type JsonContext = "schema" | "schema-map" | "data";

const dataKeywords = new Set(["const", "default", "enum", "examples"]);
const stringSetKeywords = new Set(["required", "type"]);
const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

function sortedArray(
  values: readonly unknown[],
  key: (value: unknown) => string,
): readonly unknown[] {
  return Object.freeze(
    [...values].sort((left, right) => compareCodeUnits(key(left), key(right))),
  );
}

function canonicalMember(
  key: string,
  member: unknown,
  path: string,
  depth: number,
  context: JsonContext,
): unknown {
  if (context === "data") return canonicalJson(member, path, depth, "data");
  if (context === "schema-map") {
    return canonicalJson(member, path, depth, "schema");
  }
  if (dataKeywords.has(key)) {
    const copy = canonicalJson(member, path, depth, "data");
    // Enum membership is a set: its order never changes what validates.
    return key === "enum" && Array.isArray(copy)
      ? sortedArray(copy, (entry) => JSON.stringify(entry))
      : copy;
  }
  const copy = canonicalJson(
    member,
    path,
    depth,
    schemaMapKeywords.has(key) ? "schema-map" : "schema",
  );
  if (
    stringSetKeywords.has(key) &&
    Array.isArray(copy) &&
    copy.every((entry) => typeof entry === "string")
  ) {
    return sortedArray(copy, (entry) => entry as string);
  }
  return copy;
}

/**
 * Copies a JSON value with object keys in code-unit order, and with the
 * set-valued `required`, `type`, and `enum` arrays sorted, so the serialized
 * bytes depend only on the content. JSON serialization still emits
 * integer-like keys such as `"9"` and `"10"` first, in ascending numeric
 * order. `Object.fromEntries` defines own data properties, so a `__proto__`
 * key stays an ordinary member.
 */
function canonicalJson(
  value: unknown,
  path: string,
  depth: number,
  context: JsonContext,
): unknown {
  if (depth > maximumSchemaDepth) {
    fail(
      `${path} exceeds the maximum JSON nesting depth of ${String(maximumSchemaDepth)}.`,
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry) =>
        canonicalJson(
          entry,
          path,
          depth + 1,
          context === "schema-map" ? "schema" : context,
        ),
      ),
    );
  }
  if (!isRecord(value)) fail(`${path} contains a value outside JSON.`);
  return Object.freeze(
    Object.fromEntries(
      Object.keys(value)
        .sort(compareCodeUnits)
        .map((key) => [
          key,
          canonicalMember(key, value[key], path, depth + 1, context),
        ]),
    ),
  );
}

function readSchema(value: unknown, path: string): EngineJsonSchema {
  expectRecord(value, path);
  return canonicalJson(value, path, 1, "schema") as EngineJsonSchema;
}

function readAnnotations(
  value: unknown,
  path: string,
): CapabilityAnnotations | undefined {
  if (value === undefined) return undefined;
  const record = expectRecord(value, path);
  expectOnlyKeys(record, annotationKeys, path);
  const annotations: Record<string, boolean> = {};
  for (const key of annotationKeys) {
    const hint = own(record, key);
    if (hint === undefined) continue;
    if (typeof hint !== "boolean") fail(`${path}.${key} must be a boolean.`);
    annotations[key] = hint;
  }
  return Object.freeze(annotations);
}

function readDeprecation(
  value: unknown,
  path: string,
): CapabilityDeprecation | undefined {
  if (value === undefined) return undefined;
  const record = expectRecord(value, path);
  expectOnlyKeys(record, deprecationKeys, path);
  const reason = expectString(own(record, "reason"), `${path}.reason`);
  const since = own(record, "since");
  const replacement = own(record, "replacement");
  return Object.freeze({
    reason,
    ...(since === undefined
      ? {}
      : { since: expectString(since, `${path}.since`) }),
    ...(replacement === undefined
      ? {}
      : { replacement: expectString(replacement, `${path}.replacement`) }),
  });
}

function readErrors(
  value: unknown,
  path: string,
): Readonly<Record<string, ContractErrorSnapshot>> | undefined {
  if (value === undefined) return undefined;
  const record = expectRecord(value, path);
  const entries = Object.keys(record)
    .sort(compareCodeUnits)
    .map((code) => {
      const entryPath = `${path}[${quoteIdentifier(code)}]`;
      const entry = expectRecord(record[code], entryPath);
      expectOnlyKeys(entry, errorKeys, entryPath);
      const retryable = own(entry, "retryable");
      if (typeof retryable !== "boolean") {
        fail(`${entryPath}.retryable must be a boolean.`);
      }
      const detailsSchema = own(entry, "detailsSchema");
      return [
        code,
        Object.freeze({
          description: expectString(
            own(entry, "description"),
            `${entryPath}.description`,
          ),
          retryable,
          ...(detailsSchema === undefined
            ? {}
            : {
                detailsSchema: readSchema(
                  detailsSchema,
                  `${entryPath}.detailsSchema`,
                ),
              }),
        }),
      ] as const;
    });
  return Object.freeze(Object.fromEntries(entries));
}

function readCapability(
  value: unknown,
  path: string,
): ContractCapabilitySnapshot {
  const record = expectRecord(value, path);
  expectOnlyKeys(record, capabilityKeys, path);
  const access = own(record, "access");
  if (!accessKinds.includes(access as CapabilityAccessKind)) {
    fail(`${path}.access must be "public", "authenticated", or "function".`);
  }
  const title = own(record, "title");
  const timeoutMs = own(record, "timeoutMs");
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1)
  ) {
    fail(`${path}.timeoutMs must be a positive integer.`);
  }
  const annotations = readAnnotations(
    own(record, "annotations"),
    `${path}.annotations`,
  );
  const deprecated = readDeprecation(
    own(record, "deprecated"),
    `${path}.deprecated`,
  );
  const errors = readErrors(own(record, "errors"), `${path}.errors`);
  return Object.freeze({
    ...(title === undefined
      ? {}
      : { title: expectString(title, `${path}.title`) }),
    description: expectString(
      own(record, "description"),
      `${path}.description`,
    ),
    access: access as CapabilityAccessKind,
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
    ...(annotations === undefined ? {} : { annotations }),
    ...(deprecated === undefined ? {} : { deprecated }),
    inputSchema: readSchema(own(record, "inputSchema"), `${path}.inputSchema`),
    outputSchema: readSchema(
      own(record, "outputSchema"),
      `${path}.outputSchema`,
    ),
    ...(errors === undefined ? {} : { errors }),
  });
}

/**
 * Validates an untrusted snapshot value and returns a frozen canonical copy.
 * Every field is checked against the published format; unknown fields are
 * rejected so a newer snapshot is never compared partially.
 */
export function readContractSnapshot(value: unknown): ContractSnapshot {
  const root = expectRecord(value, "snapshot");
  expectOnlyKeys(root, rootKeys, "snapshot");
  if (own(root, "formatVersion") !== 1) fail("formatVersion must be 1.");
  const engine = expectRecord(own(root, "engine"), "engine");
  expectOnlyKeys(engine, engineKeys, "engine");
  const capabilities = expectRecord(own(root, "capabilities"), "capabilities");
  const entries = Object.keys(capabilities)
    .sort(compareCodeUnits)
    .map((id) => {
      const path = `capabilities[${quoteIdentifier(id)}]`;
      return [id, readCapability(capabilities[id], path)] as const;
    });
  return Object.freeze({
    formatVersion: 1,
    engine: Object.freeze({
      name: expectString(own(engine, "name"), childPath("engine", "name")),
      version: expectString(
        own(engine, "version"),
        childPath("engine", "version"),
      ),
    }),
    capabilities: Object.freeze(Object.fromEntries(entries)),
  });
}

function captureCapability(
  description: unknown,
  id: string,
): Readonly<Record<string, unknown>> {
  const record = isRecord(description) ? description : undefined;
  const access = record === undefined ? undefined : own(record, "access");
  if (!accessKinds.includes(access as CapabilityAccessKind)) {
    fail(
      `capability ${quoteIdentifier(id)} does not describe a supported access kind.`,
    );
  }
  const fields: Record<string, unknown> = {};
  for (const key of capabilityKeys) {
    const field = own(record as UnknownRecord, key);
    if (field !== undefined) fields[key] = field;
  }
  const annotations = own(record as UnknownRecord, "annotations");
  if (isRecord(annotations)) {
    // Only the published hints with boolean values enter the contract.
    const hints = annotationKeys.flatMap((key) => {
      const hint = own(annotations, key);
      return typeof hint === "boolean" ? [[key, hint] as const] : [];
    });
    if (hints.length === 0) delete fields.annotations;
    else fields.annotations = Object.fromEntries(hints);
  }
  const errors = own(record as UnknownRecord, "errors");
  if (errors !== undefined) fields.errors = captureErrors(errors, id);
  return fields;
}

/**
 * Converts the declaration-ordered `describe().errors` list into a record
 * keyed by code, so reordering declarations never changes the snapshot.
 */
function captureErrors(value: unknown, id: string): Record<string, unknown> {
  const path = `capability ${quoteIdentifier(id)} errors`;
  if (!Array.isArray(value)) fail(`${path} must be a list.`);
  // A null prototype keeps a code such as `__proto__` an ordinary own member.
  const errors = Object.create(null) as Record<string, unknown>;
  for (const entry of value) {
    const code = isRecord(entry) ? own(entry, "code") : undefined;
    if (typeof code !== "string")
      fail(`${path} contain an entry without a code.`);
    if (Object.hasOwn(errors, code)) {
      fail(`${path} declare ${quoteIdentifier(code)} more than once.`);
    }
    const declaration = entry as UnknownRecord;
    errors[code] = Object.fromEntries(
      errorKeys.flatMap((key) => {
        const field = own(declaration, key);
        return field === undefined ? [] : [[key, field]];
      }),
    );
  }
  return errors;
}

/**
 * Captures the public contract of a constructed engine through `list` and
 * `describe`. The engine is never invoked and no adapter is started.
 */
export function createContractSnapshot<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
): ContractSnapshot {
  // A null prototype keeps an ID such as `__proto__` an ordinary own member.
  const capabilities = Object.create(null) as Record<string, unknown>;
  for (const summary of engine.list()) {
    const id = summary.id;
    if (typeof id !== "string") fail("the engine listed a non-string ID.");
    if (Object.hasOwn(capabilities, id)) {
      fail(
        `the engine listed capability ${quoteIdentifier(id)} more than once.`,
      );
    }
    capabilities[id] = captureCapability(
      engine.describe(id as Extract<keyof Capabilities, string>),
      id,
    );
  }
  return readContractSnapshot({
    formatVersion: 1,
    engine: { name: engine.name, version: engine.version },
    capabilities,
  });
}

/** Serializes a snapshot as deterministic two-space JSON with a final newline. */
export function serializeContractSnapshot(snapshot: ContractSnapshot): string {
  return `${JSON.stringify(readContractSnapshot(snapshot), null, 2)}\n`;
}
