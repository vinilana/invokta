import type { CapabilityAccessKind } from "@invokta/core";

import {
  type ContractCapabilitySnapshot,
  ContractSnapshotError,
  type ContractSnapshot,
  readContractSnapshot,
} from "./contract-snapshot.js";
import {
  escapeText,
  maximumEchoedLength,
  quoteIdentifier,
} from "./contract-text.js";

export type ContractChangeSeverity =
  | "breaking"
  | "potentially-breaking"
  | "compatible";

export type ContractChangeCode =
  | "ENGINE_NAME_CHANGED"
  | "CAPABILITY_REMOVED"
  | "CAPABILITY_ADDED"
  | "METADATA_CHANGED"
  | "ACCESS_CHANGED"
  | "TIMEOUT_CHANGED"
  | "ANNOTATIONS_CHANGED"
  | "DEPRECATION_CHANGED"
  | "PROPERTY_REMOVED"
  | "PROPERTY_ADDED"
  | "CLOSED_OUTPUT_PROPERTY_ADDED"
  | "REQUIRED_CHANGED"
  | "TYPE_CHANGED"
  | "VALUES_CHANGED"
  | "CONSTRAINT_CHANGED"
  | "ADDITIONAL_PROPERTIES_CHANGED"
  | "KEYWORD_CHANGED";

/** One classified difference between two contract snapshots. */
export interface ContractChange {
  readonly severity: ContractChangeSeverity;
  readonly code: ContractChangeCode;
  /** Absent for engine-level changes. */
  readonly capabilityId?: string;
  /** The schema that changed, when the change is inside one. */
  readonly schema?: "input" | "output";
  /** JSON Pointer inside `schema`; `""` is the schema root. */
  readonly path?: string;
  readonly message: string;
}

export interface ContractDiff {
  /** Changes in deterministic discovery order. */
  readonly changes: readonly ContractChange[];
  readonly breaking: number;
  readonly potentiallyBreaking: number;
  readonly compatible: number;
}

type Direction = "input" | "output";

/**
 * How a change moves the set of values a schema accepts. Input must keep
 * accepting what it accepted, so narrowing breaks callers; output must keep
 * producing only what it promised, so widening breaks consumers.
 */
type Effect = "narrowed" | "widened" | "incompatible" | "unknown";

type UnknownRecord = Readonly<Record<string, unknown>>;

interface SchemaScope {
  readonly capabilityId: string;
  readonly direction: Direction;
  readonly changes: ContractChange[];
}

const documentationKeywords = [
  "$comment",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
] as const;

const countBounds = [
  ["minLength", "lower"],
  ["maxLength", "upper"],
  ["minItems", "lower"],
  ["maxItems", "upper"],
  ["minProperties", "lower"],
  ["maxProperties", "upper"],
] as const;

/**
 * Each hint's value that a consumer may rely on, and the MCP default used when
 * the hint is absent. Losing a relied-upon value is potentially breaking.
 */
const annotationGuarantees = [
  ["readOnly", true, false],
  ["destructive", false, true],
  ["idempotent", true, false],
  ["openWorld", false, true],
] as const;

const maximumListedValues = 5;

/** File-controlled names in messages are bounded and escaped. */
function quote(value: string): string {
  return quoteIdentifier(value);
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: UnknownRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEqual(entry, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]),
    )
  );
}

function canonicalString(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    isRecord(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort(compareCodeUnits)
            .map((key) => [key, entry[key]]),
        )
      : entry,
  );
}

function escapePointer(segment: string): string {
  return segment.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function severityOf(
  direction: Direction,
  effect: Effect,
): ContractChangeSeverity {
  if (effect === "incompatible") return "breaking";
  if (effect === "unknown") return "potentially-breaking";
  if (direction === "input") {
    return effect === "narrowed" ? "breaking" : "compatible";
  }
  return effect === "widened" ? "breaking" : "compatible";
}

function record(
  scope: SchemaScope,
  path: string,
  code: ContractChangeCode,
  severity: ContractChangeSeverity,
  message: string,
): void {
  scope.changes.push({
    severity,
    code,
    capabilityId: scope.capabilityId,
    schema: scope.direction,
    path,
    message,
  });
}

function recordEffect(
  scope: SchemaScope,
  path: string,
  code: ContractChangeCode,
  effect: Effect,
  message: string,
): void {
  record(scope, path, code, severityOf(scope.direction, effect), message);
}

function undecidable(scope: SchemaScope, path: string, keyword: string): void {
  recordEffect(
    scope,
    path,
    "KEYWORD_CHANGED",
    "unknown",
    `The ${quote(keyword)} keyword changed and cannot be classified automatically.`,
  );
}

function compareDocumentation(
  scope: SchemaScope,
  previous: UnknownRecord,
  next: UnknownRecord,
  path: string,
): void {
  const changed = documentationKeywords.filter(
    (keyword) => !jsonEqual(own(previous, keyword), own(next, keyword)),
  );
  if (changed.length === 0) return;
  record(
    scope,
    path,
    "METADATA_CHANGED",
    "compatible",
    `Documentation keywords changed: ${changed.map(quote).join(", ")}.`,
  );
}

type TypeSet = ReadonlySet<string> | undefined | "invalid";

function readTypes(schema: UnknownRecord): TypeSet {
  const type = own(schema, "type");
  if (type === undefined) return undefined;
  if (typeof type === "string") return new Set([type]);
  if (Array.isArray(type) && type.every((entry) => typeof entry === "string")) {
    return new Set(type as string[]);
  }
  return "invalid";
}

function coversType(types: ReadonlySet<string>, type: string): boolean {
  return types.has(type) || (type === "integer" && types.has("number"));
}

function containsTypes(
  outer: ReadonlySet<string>,
  inner: ReadonlySet<string>,
): boolean {
  return [...inner].every((type) => coversType(outer, type));
}

function renderTypes(types: ReadonlySet<string> | undefined): string {
  if (types === undefined) return "any type";
  return [...types].sort(compareCodeUnits).map(quote).join(" | ");
}

function compareType(
  scope: SchemaScope,
  previous: UnknownRecord,
  next: UnknownRecord,
  path: string,
): void {
  const before = readTypes(previous);
  const after = readTypes(next);
  if (before === "invalid" || after === "invalid") {
    if (!jsonEqual(own(previous, "type"), own(next, "type"))) {
      undecidable(scope, path, "type");
    }
    return;
  }
  if (before === undefined && after === undefined) return;
  let effect: Effect;
  if (before === undefined) effect = "narrowed";
  else if (after === undefined) effect = "widened";
  else {
    const widened = containsTypes(after, before);
    const narrowed = containsTypes(before, after);
    if (widened && narrowed) return;
    effect = widened ? "widened" : narrowed ? "narrowed" : "incompatible";
  }
  recordEffect(
    scope,
    path,
    "TYPE_CHANGED",
    effect,
    `The type changed from ${renderTypes(before)} to ${renderTypes(after)}.`,
  );
}

type ValueSet = ReadonlyMap<string, unknown> | undefined | "invalid";

function readValues(schema: UnknownRecord): ValueSet {
  const hasConst = Object.hasOwn(schema, "const");
  const enumeration = own(schema, "enum");
  if (enumeration !== undefined && !Array.isArray(enumeration)) {
    return "invalid";
  }
  const values = new Map<string, unknown>();
  if (hasConst) {
    const constant = schema.const;
    const key = canonicalString(constant);
    const allowed =
      enumeration === undefined ||
      enumeration.some((entry) => canonicalString(entry) === key);
    if (allowed) values.set(key, constant);
    return values;
  }
  if (enumeration === undefined) return undefined;
  for (const entry of enumeration) values.set(canonicalString(entry), entry);
  return values;
}

function listValues(keys: readonly string[]): string {
  const listed = keys
    .slice(0, maximumListedValues)
    .map((key) => escapeText(key, maximumEchoedLength))
    .join(", ");
  const omitted = keys.length - maximumListedValues;
  return omitted > 0 ? `${listed}, and ${String(omitted)} more` : listed;
}

function compareValues(
  scope: SchemaScope,
  previous: UnknownRecord,
  next: UnknownRecord,
  path: string,
): void {
  const before = readValues(previous);
  const after = readValues(next);
  if (before === "invalid" || after === "invalid") {
    if (
      !jsonEqual(own(previous, "enum"), own(next, "enum")) ||
      !jsonEqual(own(previous, "const"), own(next, "const"))
    ) {
      undecidable(scope, path, "enum");
    }
    return;
  }
  if (before === undefined && after === undefined) return;
  if (before === undefined || after === undefined) {
    recordEffect(
      scope,
      path,
      "VALUES_CHANGED",
      before === undefined ? "narrowed" : "widened",
      before === undefined
        ? `The schema now restricts values to ${String(after?.size)} allowed value(s).`
        : "The schema no longer restricts values to a fixed set.",
    );
    return;
  }
  const removed = [...before.keys()].filter((key) => !after.has(key)).sort();
  const added = [...after.keys()].filter((key) => !before.has(key)).sort();
  if (removed.length === 0 && added.length === 0) return;
  const effect: Effect =
    added.length === 0
      ? "narrowed"
      : removed.length === 0
        ? "widened"
        : "incompatible";
  const parts = [
    ...(removed.length === 0 ? [] : [`removed ${listValues(removed)}`]),
    ...(added.length === 0 ? [] : [`added ${listValues(added)}`]),
  ];
  recordEffect(
    scope,
    path,
    "VALUES_CHANGED",
    effect,
    `Allowed values changed: ${parts.join("; ")}.`,
  );
}

interface Bound {
  readonly value: number;
  readonly exclusive: boolean;
}

type BoundSide = "lower" | "upper";

function stricter(side: BoundSide, left: Bound, right: Bound): boolean {
  if (left.value === right.value) return left.exclusive && !right.exclusive;
  return side === "lower" ? left.value > right.value : left.value < right.value;
}

function readNumericBound(
  schema: UnknownRecord,
  side: BoundSide,
): Bound | undefined | "invalid" {
  const inclusive = own(schema, side === "lower" ? "minimum" : "maximum");
  const exclusive = own(
    schema,
    side === "lower" ? "exclusiveMinimum" : "exclusiveMaximum",
  );
  if (
    (inclusive !== undefined && typeof inclusive !== "number") ||
    (exclusive !== undefined && typeof exclusive !== "number")
  ) {
    return "invalid";
  }
  const candidates: Bound[] = [
    ...(inclusive === undefined
      ? []
      : [{ value: inclusive, exclusive: false }]),
    ...(exclusive === undefined ? [] : [{ value: exclusive, exclusive: true }]),
  ];
  let selected: Bound | undefined;
  for (const candidate of candidates) {
    if (selected === undefined || stricter(side, candidate, selected)) {
      selected = candidate;
    }
  }
  return selected;
}

function renderBound(side: BoundSide, bound: Bound | undefined): string {
  if (bound === undefined) return "none";
  const operator =
    side === "lower"
      ? bound.exclusive
        ? ">"
        : ">="
      : bound.exclusive
        ? "<"
        : "<=";
  return `${operator} ${String(bound.value)}`;
}

function boundEffect(
  side: BoundSide,
  before: Bound | undefined,
  after: Bound | undefined,
): Effect | undefined {
  if (before === undefined && after === undefined) return undefined;
  if (before === undefined) return "narrowed";
  if (after === undefined) return "widened";
  if (before.value === after.value && before.exclusive === after.exclusive) {
    return undefined;
  }
  return stricter(side, after, before) ? "narrowed" : "widened";
}

function compareNumericBound(
  scope: SchemaScope,
  previous: UnknownRecord,
  next: UnknownRecord,
  path: string,
  side: BoundSide,
): void {
  const before = readNumericBound(previous, side);
  const after = readNumericBound(next, side);
  if (before === "invalid" || after === "invalid") {
    undecidable(scope, path, side === "lower" ? "minimum" : "maximum");
    return;
  }
  const effect = boundEffect(side, before, after);
  if (effect === undefined) return;
  recordEffect(
    scope,
    path,
    "CONSTRAINT_CHANGED",
    effect,
    `The numeric ${side} bound changed from ${renderBound(side, before)} to ${renderBound(side, after)}.`,
  );
}

function compareCountBound(
  scope: SchemaScope,
  previous: UnknownRecord,
  next: UnknownRecord,
  path: string,
  keyword: string,
  side: BoundSide,
): void {
  const before = own(previous, keyword);
  const after = own(next, keyword);
  if (jsonEqual(before, after)) return;
  if (
    (before !== undefined && typeof before !== "number") ||
    (after !== undefined && typeof after !== "number")
  ) {
    undecidable(scope, path, keyword);
    return;
  }
  const effect = boundEffect(
    side,
    before === undefined ? undefined : { value: before, exclusive: false },
    after === undefined ? undefined : { value: after, exclusive: false },
  );
  if (effect === undefined) return;
  recordEffect(
    scope,
    path,
    "CONSTRAINT_CHANGED",
    effect,
    `${quote(keyword)} changed from ${before === undefined ? "none" : String(before)} to ${after === undefined ? "none" : String(after)}.`,
  );
}

/**
 * Compares a keyword whose addition always narrows and whose removal always
 * widens, but whose replacement cannot be compared without evaluating it.
 */
function compareRestriction(
  scope: SchemaScope,
  previous: UnknownRecord,
  next: UnknownRecord,
  path: string,
  keyword: string,
): void {
  const before = own(previous, keyword);
  const after = own(next, keyword);
  if (jsonEqual(before, after)) return;
  const effect: Effect =
    before === undefined
      ? "narrowed"
      : after === undefined
        ? "widened"
        : "unknown";
  recordEffect(
    scope,
    path,
    "CONSTRAINT_CHANGED",
    effect,
    before === undefined
      ? `${quote(keyword)} was added.`
      : after === undefined
        ? `${quote(keyword)} was removed.`
        : `${quote(keyword)} changed and cannot be compared automatically.`,
  );
}

function compareUniqueItems(
  scope: SchemaScope,
  previous: UnknownRecord,
  next: UnknownRecord,
  path: string,
): void {
  const before = own(previous, "uniqueItems");
  const after = own(next, "uniqueItems");
  if (jsonEqual(before, after)) return;
  if (
    (before !== undefined && typeof before !== "boolean") ||
    (after !== undefined && typeof after !== "boolean")
  ) {
    undecidable(scope, path, "uniqueItems");
    return;
  }
  if ((before === true) === (after === true)) return;
  recordEffect(
    scope,
    path,
    "CONSTRAINT_CHANGED",
    after === true ? "narrowed" : "widened",
    after === true
      ? "Array items must now be unique."
      : "Array items no longer need to be unique.",
  );
}

function compareFormat(
  scope: SchemaScope,
  previous: UnknownRecord,
  next: UnknownRecord,
  path: string,
): void {
  if (jsonEqual(own(previous, "format"), own(next, "format"))) return;
  recordEffect(
    scope,
    path,
    "CONSTRAINT_CHANGED",
    "unknown",
    'The "format" keyword changed; whether it is asserted depends on the validator.',
  );
}

type AdditionalKind = "open" | "closed" | "schema" | "invalid";

function additionalKind(value: unknown): AdditionalKind {
  if (value === undefined || value === true) return "open";
  if (value === false) return "closed";
  if (isRecord(value))
    return Object.keys(value).length === 0 ? "open" : "schema";
  return "invalid";
}

const additionalDescriptions: Readonly<Record<AdditionalKind, string>> = {
  open: "allowed",
  closed: "rejected",
  schema: "constrained by a schema",
  invalid: "invalid",
};

function compareAdditionalProperties(
  scope: SchemaScope,
  previous: UnknownRecord,
  next: UnknownRecord,
  path: string,
): void {
  const before = own(previous, "additionalProperties");
  const after = own(next, "additionalProperties");
  if (jsonEqual(before, after)) return;
  const beforeKind = additionalKind(before);
  const afterKind = additionalKind(after);
  if (beforeKind === "invalid" || afterKind === "invalid") {
    undecidable(scope, path, "additionalProperties");
    return;
  }
  if (beforeKind === "schema" && afterKind === "schema") {
    compareSchema(scope, before, after, `${path}/additionalProperties`);
    return;
  }
  if (beforeKind === afterKind) return;
  const message = `Additional properties changed from ${additionalDescriptions[beforeKind]} to ${additionalDescriptions[afterKind]}.`;
  const narrowed =
    afterKind === "closed" || (beforeKind === "open" && afterKind === "schema");
  if (scope.direction === "output" && beforeKind === "closed") {
    // Formally a widening, but only clients validating against the cached
    // closed schema reject results; flag it for review rather than block.
    record(
      scope,
      path,
      "ADDITIONAL_PROPERTIES_CHANGED",
      "potentially-breaking",
      `${message} Clients that validate results against a cached copy of the previous closed schema, such as the official MCP SDK client, reject additional properties until they list tools again.`,
    );
    return;
  }
  recordEffect(
    scope,
    path,
    "ADDITIONAL_PROPERTIES_CHANGED",
    narrowed ? "narrowed" : "widened",
    message,
  );
}

function readRequired(schema: UnknownRecord): ReadonlySet<string> | "invalid" {
  const required = own(schema, "required");
  if (required === undefined) return new Set();
  if (
    !Array.isArray(required) ||
    !required.every((entry) => typeof entry === "string")
  ) {
    return "invalid";
  }
  return new Set(required as string[]);
}

function readProperties(schema: UnknownRecord): UnknownRecord | "invalid" {
  const properties = own(schema, "properties");
  if (properties === undefined) return {};
  return isRecord(properties) ? properties : "invalid";
}

function compareProperty(
  scope: SchemaScope,
  name: string,
  previous: {
    readonly properties: UnknownRecord;
    readonly required: ReadonlySet<string>;
    readonly additional: unknown;
    readonly patterned: boolean;
  },
  next: {
    readonly properties: UnknownRecord;
    readonly required: ReadonlySet<string>;
    readonly closed: boolean;
  },
  path: string,
): void {
  const propertyPath = `${path}/properties/${escapePointer(name)}`;
  const inBefore = Object.hasOwn(previous.properties, name);
  const inAfter = Object.hasOwn(next.properties, name);
  const requiredBefore = previous.required.has(name);
  const requiredAfter = next.required.has(name);
  if (inBefore && !inAfter) {
    if (scope.direction === "output") {
      record(
        scope,
        propertyPath,
        "PROPERTY_REMOVED",
        "breaking",
        "The output property was removed.",
      );
    } else if (next.closed) {
      record(
        scope,
        propertyPath,
        "PROPERTY_REMOVED",
        "breaking",
        "The input property was removed and additional properties are rejected.",
      );
    } else {
      record(
        scope,
        propertyPath,
        "PROPERTY_REMOVED",
        "potentially-breaking",
        "The input property was removed; values sent for it are no longer validated.",
      );
    }
    return;
  }
  if (!inBefore && inAfter) {
    compareAddedProperty(
      scope,
      propertyPath,
      next.properties[name],
      requiredAfter,
      previous,
    );
    return;
  }
  if (inBefore && inAfter) {
    compareSchema(
      scope,
      previous.properties[name],
      next.properties[name],
      propertyPath,
    );
  }
  if (requiredBefore === requiredAfter) return;
  recordEffect(
    scope,
    propertyPath,
    "REQUIRED_CHANGED",
    requiredAfter ? "narrowed" : "widened",
    requiredAfter
      ? "The property is now required."
      : "The property is now optional.",
  );
}

/**
 * Classifies a property that the previous schema did not name. Before, its
 * values were governed by `additionalProperties` (or `patternProperties`), so
 * the addition is only free when that rule accepted anything.
 */
function compareAddedProperty(
  scope: SchemaScope,
  path: string,
  schema: unknown,
  required: boolean,
  previous: { readonly additional: unknown; readonly patterned: boolean },
): void {
  const label = `${required ? "A required" : "An optional"} ${scope.direction} property was added`;
  if (scope.direction === "input" && required) {
    record(scope, path, "PROPERTY_ADDED", "breaking", `${label}.`);
    return;
  }
  const previousKind = additionalKind(previous.additional);
  if (
    previous.patterned ||
    previousKind === "invalid" ||
    (previousKind === "schema" && !jsonEqual(previous.additional, schema))
  ) {
    record(
      scope,
      path,
      "PROPERTY_ADDED",
      "potentially-breaking",
      `${label}; its values were previously governed by ${previous.patterned ? '"patternProperties"' : '"additionalProperties"'}, and the new schema differs.`,
    );
    return;
  }
  if (scope.direction === "output" && previousKind === "closed") {
    record(
      scope,
      path,
      "CLOSED_OUTPUT_PROPERTY_ADDED",
      "potentially-breaking",
      `${label} to an object whose previous schema rejected additional properties. Clients that validate results against a cached copy of that schema, such as the official MCP SDK client, reject results until they list tools again.`,
    );
    return;
  }
  record(scope, path, "PROPERTY_ADDED", "compatible", `${label}.`);
}

function hasPatternProperties(schema: UnknownRecord): boolean {
  const patterns = own(schema, "patternProperties");
  if (patterns === undefined) return false;
  return !isRecord(patterns) || Object.keys(patterns).length > 0;
}

function compareObject(
  scope: SchemaScope,
  previous: UnknownRecord,
  next: UnknownRecord,
  path: string,
): void {
  const beforeProperties = readProperties(previous);
  const afterProperties = readProperties(next);
  const beforeRequired = readRequired(previous);
  const afterRequired = readRequired(next);
  if (beforeProperties === "invalid" || afterProperties === "invalid") {
    undecidable(scope, path, "properties");
  } else if (beforeRequired === "invalid" || afterRequired === "invalid") {
    undecidable(scope, path, "required");
  } else {
    const closed = own(next, "additionalProperties") === false;
    const names = new Set([
      ...Object.keys(beforeProperties),
      ...Object.keys(afterProperties),
      ...beforeRequired,
      ...afterRequired,
    ]);
    for (const name of [...names].sort(compareCodeUnits)) {
      compareProperty(
        scope,
        name,
        {
          properties: beforeProperties,
          required: beforeRequired,
          additional: own(previous, "additionalProperties"),
          patterned: hasPatternProperties(previous),
        },
        { properties: afterProperties, required: afterRequired, closed },
        path,
      );
    }
  }
  compareAdditionalProperties(scope, previous, next, path);
}

function compareItems(
  scope: SchemaScope,
  previous: UnknownRecord,
  next: UnknownRecord,
  path: string,
): void {
  const before = own(previous, "items");
  const after = own(next, "items");
  if (jsonEqual(before, after)) return;
  if (Array.isArray(before) || Array.isArray(after)) {
    undecidable(scope, path, "items");
    return;
  }
  compareSchema(scope, before ?? true, after ?? true, `${path}/items`);
}

const classifiedKeywords = new Set<string>([
  ...documentationKeywords,
  "type",
  "enum",
  "const",
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "exclusiveMaximum",
  ...countBounds.map(([keyword]) => keyword),
  "multipleOf",
  "pattern",
  "uniqueItems",
  "format",
  "properties",
  "required",
  "additionalProperties",
  "items",
]);

const nullSchema: UnknownRecord = { type: "null" };

/** Keywords allowed beside a nullable `anyOf`; none of them can reject null. */
const nullableSiblingKeywords = new Set<string>([
  ...documentationKeywords,
  "default",
]);

/**
 * One side of a comparison split into its non-null part and whether it also
 * accepts null. Schema libraries emit a nullable value either as
 * `type: [T, "null"]` or as `anyOf: [S, { type: "null" }]`; both decompose to
 * the same view so the non-null part stays comparable.
 */
interface NullableView {
  readonly inner: unknown;
  readonly innerPath: string;
  readonly siblings: UnknownRecord;
  readonly nullable: boolean;
}

function nullableAnyOf(
  schema: UnknownRecord,
  path: string,
): NullableView | undefined {
  const branches = own(schema, "anyOf");
  if (!Array.isArray(branches) || branches.length !== 2) return undefined;
  const nullIndex = branches.findIndex((branch) =>
    jsonEqual(branch, nullSchema),
  );
  if (nullIndex === -1) return undefined;
  const innerIndex = nullIndex === 0 ? 1 : 0;
  const inner: unknown = branches[innerIndex];
  if (
    jsonEqual(inner, nullSchema) ||
    !(typeof inner === "boolean" || isRecord(inner))
  ) {
    return undefined;
  }
  const siblings = Object.fromEntries(
    Object.entries(schema).filter(([keyword]) => keyword !== "anyOf"),
  );
  if (!Object.keys(siblings).every((key) => nullableSiblingKeywords.has(key))) {
    return undefined;
  }
  return {
    inner,
    innerPath: `${path}/anyOf/${String(innerIndex)}`,
    siblings,
    nullable: true,
  };
}

/** Keywords whose effect on null cannot be read off the schema node itself. */
const nullOpaqueKeywords = ["$ref", "allOf", "anyOf", "if", "not", "oneOf"];

/**
 * Splits a schema that is not in the nullable `anyOf` form into its non-null
 * part and whether it accepts null. It accepts null only when `type` is absent
 * or includes `"null"`, `enum` is absent or contains `null`, and `const` is
 * absent or `null`. A composition keyword could also reject null, so such a
 * schema is not split and the caller falls back to the generic comparison.
 */
function plainView(
  schema: UnknownRecord,
  path: string,
): NullableView | undefined {
  if (nullOpaqueKeywords.some((keyword) => Object.hasOwn(schema, keyword))) {
    return undefined;
  }
  const types = readTypes(schema);
  const values = own(schema, "enum");
  if (types === "invalid" || (values !== undefined && !Array.isArray(values))) {
    return undefined;
  }
  const hasConst = Object.hasOwn(schema, "const");
  const nullable =
    (types === undefined || types.has("null")) &&
    (values === undefined || values.includes(null)) &&
    (!hasConst || schema.const === null);
  const remainingTypes =
    types === undefined
      ? undefined
      : [...types].filter((type) => type !== "null").sort(compareCodeUnits);
  const remainingValues = values?.filter((value) => value !== null);
  // Without null, a schema that only allowed null rejects every value.
  if (
    remainingTypes?.length === 0 ||
    remainingValues?.length === 0 ||
    (hasConst && schema.const === null)
  ) {
    return { inner: false, innerPath: path, siblings: {}, nullable };
  }
  return {
    inner: {
      ...schema,
      ...(remainingTypes === undefined
        ? {}
        : {
            type:
              remainingTypes.length === 1 ? remainingTypes[0] : remainingTypes,
          }),
      ...(remainingValues === undefined ? {} : { enum: remainingValues }),
    },
    innerPath: path,
    siblings: {},
    nullable,
  };
}

function compareNullable(
  scope: SchemaScope,
  before: NullableView,
  after: NullableView,
  path: string,
): void {
  if (before.nullable !== after.nullable) {
    recordEffect(
      scope,
      path,
      "TYPE_CHANGED",
      after.nullable ? "widened" : "narrowed",
      after.nullable
        ? "The schema now also accepts null."
        : "The schema no longer accepts null.",
    );
  }
  compareDocumentation(scope, before.siblings, after.siblings, path);
  if (
    !jsonEqual(own(before.siblings, "default"), own(after.siblings, "default"))
  ) {
    undecidable(scope, path, "default");
  }
  compareSchema(scope, before.inner, after.inner, after.innerPath);
}

function normalizeSchema(value: unknown): UnknownRecord | "never" | "invalid" {
  if (value === true) return {};
  if (value === false) return "never";
  return isRecord(value) ? value : "invalid";
}

function compareSchema(
  scope: SchemaScope,
  previous: unknown,
  next: unknown,
  path: string,
): void {
  if (jsonEqual(previous, next)) return;
  const before = normalizeSchema(previous);
  const after = normalizeSchema(next);
  if (before === "invalid" || after === "invalid") {
    recordEffect(
      scope,
      path,
      "KEYWORD_CHANGED",
      "unknown",
      "The schema is not a JSON Schema object or boolean.",
    );
    return;
  }
  if (before === "never" || after === "never") {
    recordEffect(
      scope,
      path,
      "TYPE_CHANGED",
      before === "never" ? "widened" : "narrowed",
      before === "never"
        ? "The schema no longer rejects every value."
        : "The schema now rejects every value.",
    );
    return;
  }
  const beforeNullable = nullableAnyOf(before, path);
  const afterNullable = nullableAnyOf(after, path);
  if (beforeNullable !== undefined || afterNullable !== undefined) {
    const beforeView = beforeNullable ?? plainView(before, path);
    const afterView = afterNullable ?? plainView(after, path);
    if (beforeView !== undefined && afterView !== undefined) {
      compareNullable(scope, beforeView, afterView, path);
      return;
    }
  }
  compareDocumentation(scope, before, after, path);
  compareType(scope, before, after, path);
  compareValues(scope, before, after, path);
  compareNumericBound(scope, before, after, path, "lower");
  compareNumericBound(scope, before, after, path, "upper");
  for (const [keyword, side] of countBounds) {
    compareCountBound(scope, before, after, path, keyword, side);
  }
  compareRestriction(scope, before, after, path, "multipleOf");
  compareRestriction(scope, before, after, path, "pattern");
  compareUniqueItems(scope, before, after, path);
  compareFormat(scope, before, after, path);
  compareObject(scope, before, after, path);
  compareItems(scope, before, after, path);
  const keywords = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const keyword of [...keywords].sort(compareCodeUnits)) {
    if (classifiedKeywords.has(keyword)) continue;
    if (!jsonEqual(own(before, keyword), own(after, keyword))) {
      undecidable(scope, path, keyword);
    }
  }
}

function capabilityChange(
  changes: ContractChange[],
  capabilityId: string,
  code: ContractChangeCode,
  severity: ContractChangeSeverity,
  message: string,
): void {
  changes.push({ severity, code, capabilityId, message });
}

function renderAccess(access: CapabilityAccessKind): string {
  return access === "function" ? "a function rule" : quote(access);
}

function accessSeverity(
  before: CapabilityAccessKind,
  after: CapabilityAccessKind,
): ContractChangeSeverity {
  if (after === "public") return "compatible";
  if (before === "public") return "breaking";
  return "potentially-breaking";
}

function compareCapability(
  changes: ContractChange[],
  id: string,
  before: ContractCapabilitySnapshot,
  after: ContractCapabilitySnapshot,
): void {
  const metadata = (["title", "description"] as const).filter(
    (field) => before[field] !== after[field],
  );
  if (metadata.length > 0) {
    capabilityChange(
      changes,
      id,
      "METADATA_CHANGED",
      "compatible",
      `Capability metadata changed: ${metadata.map(quote).join(", ")}.`,
    );
  }
  if (before.access !== after.access) {
    capabilityChange(
      changes,
      id,
      "ACCESS_CHANGED",
      accessSeverity(before.access, after.access),
      `Access changed from ${renderAccess(before.access)} to ${renderAccess(after.access)}.`,
    );
  }
  if (before.timeoutMs !== after.timeoutMs) {
    const shorter =
      after.timeoutMs !== undefined &&
      (before.timeoutMs === undefined || after.timeoutMs < before.timeoutMs);
    capabilityChange(
      changes,
      id,
      "TIMEOUT_CHANGED",
      shorter ? "potentially-breaking" : "compatible",
      before.timeoutMs === undefined
        ? `A timeout of ${String(after.timeoutMs)} ms was added.`
        : after.timeoutMs === undefined
          ? `The timeout of ${String(before.timeoutMs)} ms was removed.`
          : `The timeout changed from ${String(before.timeoutMs)} ms to ${String(after.timeoutMs)} ms.`,
    );
  }
  for (const [hint, guarantee, fallback] of annotationGuarantees) {
    const rawBefore = before.annotations?.[hint];
    const rawAfter = after.annotations?.[hint];
    if (rawBefore === rawAfter) continue;
    const lost =
      (rawBefore ?? fallback) === guarantee &&
      (rawAfter ?? fallback) !== guarantee;
    capabilityChange(
      changes,
      id,
      "ANNOTATIONS_CHANGED",
      lost ? "potentially-breaking" : "compatible",
      `The ${quote(hint)} hint changed from ${rawBefore === undefined ? "unset" : String(rawBefore)} to ${rawAfter === undefined ? "unset" : String(rawAfter)}.`,
    );
  }
  if (!jsonEqual(before.deprecated, after.deprecated)) {
    capabilityChange(
      changes,
      id,
      "DEPRECATION_CHANGED",
      "compatible",
      before.deprecated === undefined
        ? "The capability was deprecated."
        : after.deprecated === undefined
          ? "The deprecation notice was removed."
          : "The deprecation notice changed.",
    );
  }
  compareSchema(
    { capabilityId: id, direction: "input", changes },
    before.inputSchema,
    after.inputSchema,
    "",
  );
  compareSchema(
    { capabilityId: id, direction: "output", changes },
    before.outputSchema,
    after.outputSchema,
    "",
  );
}

function readSnapshotArgument(
  value: ContractSnapshot,
  label: "previous" | "next",
): ContractSnapshot {
  try {
    return readContractSnapshot(value);
  } catch (error) {
    if (error instanceof ContractSnapshotError) {
      throw new ContractSnapshotError(`${label} snapshot: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Classifies every difference between two contract snapshots. A change the
 * JSON Schema comparison cannot decide is potentially breaking, never guessed
 * compatible.
 */
export function diffContractSnapshots(
  previous: ContractSnapshot,
  next: ContractSnapshot,
): ContractDiff {
  const before = readSnapshotArgument(previous, "previous");
  const after = readSnapshotArgument(next, "next");
  const changes: ContractChange[] = [];
  if (before.engine.name !== after.engine.name) {
    changes.push({
      severity: "potentially-breaking",
      code: "ENGINE_NAME_CHANGED",
      message: `The engine name changed from ${quote(before.engine.name)} to ${quote(after.engine.name)}.`,
    });
  }
  const ids = new Set([
    ...Object.keys(before.capabilities),
    ...Object.keys(after.capabilities),
  ]);
  for (const id of [...ids].sort(compareCodeUnits)) {
    const beforeCapability = Object.hasOwn(before.capabilities, id)
      ? before.capabilities[id]
      : undefined;
    const afterCapability = Object.hasOwn(after.capabilities, id)
      ? after.capabilities[id]
      : undefined;
    if (afterCapability === undefined) {
      capabilityChange(
        changes,
        id,
        "CAPABILITY_REMOVED",
        "breaking",
        "The capability was removed.",
      );
    } else if (beforeCapability === undefined) {
      capabilityChange(
        changes,
        id,
        "CAPABILITY_ADDED",
        "compatible",
        "The capability was added.",
      );
    } else {
      compareCapability(changes, id, beforeCapability, afterCapability);
    }
  }
  const count = (severity: ContractChangeSeverity) =>
    changes.filter((change) => change.severity === severity).length;
  return Object.freeze({
    changes: Object.freeze(changes.map((change) => Object.freeze(change))),
    breaking: count("breaking"),
    potentiallyBreaking: count("potentially-breaking"),
    compatible: count("compatible"),
  });
}
