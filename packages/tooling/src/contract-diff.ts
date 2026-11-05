import type { CapabilityAccessKind } from "@invokta/core";

import {
  type ContractCapabilitySnapshot,
  ContractSnapshotError,
  type ContractSnapshot,
  readContractSnapshot,
} from "./contract-snapshot.js";

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

function quote(value: string): string {
  return JSON.stringify(value);
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
  const listed = keys.slice(0, maximumListedValues).join(", ");
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
    // Consumers must tolerate additional output properties (stability policy).
    record(scope, path, "ADDITIONAL_PROPERTIES_CHANGED", "compatible", message);
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
    const breaking = scope.direction === "input" && requiredAfter;
    record(
      scope,
      propertyPath,
      "PROPERTY_ADDED",
      breaking ? "breaking" : "compatible",
      `${requiredAfter ? "A required" : "An optional"} ${scope.direction} property was added.`,
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
        { properties: beforeProperties, required: beforeRequired },
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
