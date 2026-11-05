import type { CapabilityDescription } from "@invokta/core";

import { CliUsageError } from "./usage.js";

type FlagValueType = "string" | "number" | "integer" | "boolean";
export type FlagScalar = string | number | boolean;

export interface CapabilityFlag {
  readonly property: string;
  /** Kebab-case spelling without the leading `--`. */
  readonly name: string;
  readonly type: FlagValueType;
  readonly repeatable: boolean;
  readonly required: boolean;
  readonly description?: string;
  readonly allowed?: readonly FlagScalar[];
  readonly default?: { readonly value: unknown };
}

export type InputOnlyReason =
  | "nested object"
  | "unsupported schema"
  | "reserved option name"
  | "flag name collision"
  | "no flag spelling";

export interface InputOnlyProperty {
  readonly property: string;
  readonly reason: InputOnlyReason;
  readonly required: boolean;
}

type Spelling =
  | {
      readonly kind: "flag";
      readonly flag: CapabilityFlag;
      readonly negated: boolean;
    }
  | {
      readonly kind: "input-only";
      readonly properties: readonly InputOnlyProperty[];
    };

export interface CapabilityFlags {
  readonly flags: readonly CapabilityFlag[];
  readonly inputOnly: readonly InputOnlyProperty[];
  readonly spellings: ReadonlyMap<string, Spelling>;
}

/** CLI-owned option names; a property with one of these spellings is input-only. */
const reservedOptionNames: ReadonlySet<string> = new Set([
  "input",
  "stdin",
  "help",
  "format",
]);

const maximumFlagNameLength = 64;
const propertyNamePattern = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const echoableFlagNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const jsonNumberPattern =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;
const scalarTypes: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
]);

/**
 * Maps a property name to its kebab-case flag spelling. Only names that start
 * with an ASCII letter and contain ASCII letters, digits, `_`, and `-` have a
 * spelling, and the spelling is at most 64 characters.
 */
function toFlagName(property: string): string | undefined {
  if (!propertyNamePattern.test(property)) return undefined;
  const name = property
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1-$2")
    .split(/[-_]+/u)
    .filter((word) => word !== "")
    .join("-")
    .toLowerCase();
  return name.length <= maximumFlagNameLength ? name : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is FlagScalar {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function matchesType(value: FlagScalar, type: FlagValueType): boolean {
  if (type === "integer") return Number.isSafeInteger(value);
  return typeof value === (type === "number" ? "number" : type);
}

/** Reads `const` or `enum`; `null` marks a declaration flags cannot express. */
function readAllowed(
  schema: Readonly<Record<string, unknown>>,
): readonly FlagScalar[] | null | undefined {
  const hasConst = Object.hasOwn(schema, "const");
  const hasEnum = Object.hasOwn(schema, "enum");
  if (hasConst && hasEnum) return null;
  if (hasConst) return isScalar(schema.const) ? [schema.const] : null;
  if (!hasEnum) return undefined;
  const values = schema.enum;
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.every(isScalar) ? [...values] : null;
}

function inferType(values: readonly FlagScalar[]): FlagValueType | undefined {
  if (values.every((value) => typeof value === "string")) return "string";
  if (values.every((value) => typeof value === "boolean")) return "boolean";
  if (values.every((value) => typeof value === "number")) return "number";
  return undefined;
}

interface ScalarShape {
  readonly type: FlagValueType;
  readonly allowed?: readonly FlagScalar[];
}

function classifyScalar(schema: unknown): ScalarShape | undefined {
  if (!isRecord(schema)) return undefined;
  const declared = schema.type;
  if (
    declared !== undefined &&
    !(typeof declared === "string" && scalarTypes.has(declared))
  ) {
    return undefined;
  }
  const allowed = readAllowed(schema);
  if (allowed === null) return undefined;
  const type =
    declared === undefined
      ? allowed === undefined
        ? undefined
        : inferType(allowed)
      : (declared as FlagValueType);
  if (type === undefined) return undefined;
  if (allowed === undefined) return { type };
  if (!allowed.every((value) => matchesType(value, type))) return undefined;
  return { type, allowed };
}

type Classification =
  | ({ readonly kind: "flag"; readonly repeatable: boolean } & ScalarShape)
  | {
      readonly kind: "input-only";
      readonly reason: "nested object" | "unsupported schema";
    };

function classify(schema: unknown): Classification {
  if (isRecord(schema) && schema.type === "object") {
    return { kind: "input-only", reason: "nested object" };
  }
  const scalar = classifyScalar(schema);
  if (scalar !== undefined) {
    return { kind: "flag", repeatable: false, ...scalar };
  }
  if (
    isRecord(schema) &&
    schema.type === "array" &&
    !Object.hasOwn(schema, "prefixItems")
  ) {
    const items = classifyScalar(schema.items);
    if (items !== undefined) {
      return { kind: "flag", repeatable: true, ...items };
    }
  }
  return { kind: "input-only", reason: "unsupported schema" };
}

interface Candidate {
  readonly property: string;
  readonly name: string | undefined;
  readonly schema: unknown;
  readonly classification: Classification;
  readonly required: boolean;
}

function candidateSpellings(candidate: Candidate): readonly string[] {
  if (candidate.name === undefined) return [];
  return candidate.classification.kind === "flag" &&
    candidate.classification.type === "boolean"
    ? [candidate.name, `no-${candidate.name}`]
    : [candidate.name];
}

/**
 * Derives the flag table of one capability from the top-level properties of
 * its published input schema, in schema order.
 */
export function deriveCapabilityFlags(
  description: CapabilityDescription,
): CapabilityFlags {
  const inputSchema: unknown = description.inputSchema;
  const root = isRecord(inputSchema) ? inputSchema : {};
  const properties = isRecord(root.properties) ? root.properties : {};
  const required = new Set(
    Array.isArray(root.required)
      ? root.required.filter((entry) => typeof entry === "string")
      : [],
  );
  const candidates: Candidate[] = Object.keys(properties).map((property) => {
    const schema = properties[property];
    return {
      property,
      name: toFlagName(property),
      schema,
      classification: classify(schema),
      required: required.has(property),
    };
  });

  const claimants = new Map<string, number>();
  for (const candidate of candidates) {
    if (
      candidate.name === undefined ||
      reservedOptionNames.has(candidate.name)
    ) {
      continue;
    }
    for (const spelling of candidateSpellings(candidate)) {
      claimants.set(spelling, (claimants.get(spelling) ?? 0) + 1);
    }
  }

  const flags: CapabilityFlag[] = [];
  const inputOnly: InputOnlyProperty[] = [];
  const spellings = new Map<string, Spelling>();
  const inputOnlySpellings = new Map<string, InputOnlyProperty[]>();
  for (const candidate of candidates) {
    const { classification, name, property } = candidate;
    const collides =
      name !== undefined &&
      candidateSpellings(candidate).some(
        (spelling) => (claimants.get(spelling) ?? 0) > 1,
      );
    const reason: InputOnlyReason | undefined =
      name === undefined
        ? "no flag spelling"
        : reservedOptionNames.has(name)
          ? "reserved option name"
          : collides
            ? "flag name collision"
            : classification.kind === "input-only"
              ? classification.reason
              : undefined;
    if (reason !== undefined || classification.kind !== "flag") {
      const entry: InputOnlyProperty = Object.freeze({
        property,
        reason: reason ?? "unsupported schema",
        required: candidate.required,
      });
      inputOnly.push(entry);
      for (const spelling of candidateSpellings(candidate)) {
        const entries = inputOnlySpellings.get(spelling) ?? [];
        entries.push(entry);
        inputOnlySpellings.set(spelling, entries);
      }
      continue;
    }
    const schema = isRecord(candidate.schema) ? candidate.schema : {};
    const flag: CapabilityFlag = Object.freeze({
      property,
      name: name as string,
      type: classification.type,
      repeatable: classification.repeatable,
      required: candidate.required,
      ...(typeof schema.description === "string"
        ? { description: schema.description }
        : {}),
      ...(classification.allowed === undefined
        ? {}
        : { allowed: Object.freeze([...classification.allowed]) }),
      ...(Object.hasOwn(schema, "default")
        ? { default: Object.freeze({ value: schema.default }) }
        : {}),
    });
    flags.push(flag);
    spellings.set(flag.name, { kind: "flag", flag, negated: false });
    if (flag.type === "boolean") {
      spellings.set(`no-${flag.name}`, { kind: "flag", flag, negated: true });
    }
  }
  for (const [spelling, properties] of inputOnlySpellings) {
    if (!spellings.has(spelling)) {
      spellings.set(spelling, {
        kind: "input-only",
        properties: Object.freeze(properties),
      });
    }
  }
  return Object.freeze({
    flags: Object.freeze(flags),
    inputOnly: Object.freeze(inputOnly),
    spellings,
  });
}

/** Renders a property name for a diagnostic or help line. */
export function displayProperty(property: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(property)
    ? property
    : JSON.stringify(property);
}

function unknownFlag(capabilityId: string, name: string): CliUsageError {
  const flag = echoableFlagNamePattern.test(name)
    ? `Unknown flag --${name}.`
    : "Unknown flag.";
  return new CliUsageError(
    `${flag} Run "engine help ${capabilityId}" to list this capability's flags, or pass the whole input with --input or --stdin.`,
  );
}

function inputOnlyFlag(
  name: string,
  properties: readonly InputOnlyProperty[],
): CliUsageError {
  const [first] = properties;
  if (properties.length === 1 && first !== undefined) {
    return new CliUsageError(
      `Property ${displayProperty(first.property)} cannot be set with a flag (${first.reason}); use --input or --stdin.`,
      false,
    );
  }
  return new CliUsageError(
    `Flag --${name} is ambiguous between properties ${properties
      .map((entry) => displayProperty(entry.property))
      .join(" and ")} (flag name collision); use --input or --stdin.`,
    false,
  );
}

function decodeValue(
  flag: CapabilityFlag,
  name: string,
  raw: string,
): FlagScalar {
  if (flag.type === "string") return raw;
  const value = jsonNumberPattern.test(raw)
    ? (JSON.parse(raw) as number)
    : Number.NaN;
  if (flag.type === "integer") {
    if (Number.isSafeInteger(value)) return value;
    throw new CliUsageError(`Flag --${name} expects an integer.`, false);
  }
  if (Number.isFinite(value)) return value;
  throw new CliUsageError(`Flag --${name} expects a number.`, false);
}

function decodeBoolean(
  negated: boolean,
  name: string,
  inline: string | undefined,
): boolean {
  if (negated) {
    if (inline === undefined) return false;
    throw new CliUsageError(`Flag --${name} does not take a value.`, false);
  }
  if (inline === undefined || inline === "true") return true;
  if (inline === "false") return false;
  throw new CliUsageError(`Flag --${name} expects true or false.`, false);
}

/**
 * Builds the JSON input object from schema-derived flags. It only decodes each
 * value by its declared type; required properties, defaults, enum membership,
 * and every other constraint remain with the capability's input validation.
 */
export function parseFlagInput(
  capabilityId: string,
  table: CapabilityFlags,
  argumentsList: readonly string[],
): Readonly<Record<string, unknown>> {
  const values = new Map<CapabilityFlag, FlagScalar | FlagScalar[]>();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (typeof token !== "string" || !token.startsWith("--")) {
      throw new CliUsageError(
        "Unexpected argument. Each run argument must be a flag that starts with --.",
      );
    }
    const separator = token.indexOf("=");
    const name = token.slice(2, separator === -1 ? undefined : separator);
    const inline = separator === -1 ? undefined : token.slice(separator + 1);
    const spelling = table.spellings.get(name);
    if (spelling === undefined) throw unknownFlag(capabilityId, name);
    if (spelling.kind === "input-only") {
      throw inputOnlyFlag(name, spelling.properties);
    }
    const { flag } = spelling;
    let value: FlagScalar;
    if (flag.type === "boolean") {
      value = decodeBoolean(spelling.negated, name, inline);
    } else {
      let raw = inline;
      if (raw === undefined) {
        const next = argumentsList[index + 1];
        if (typeof next !== "string" || next.startsWith("--")) {
          throw new CliUsageError(
            `Flag --${name} requires a value. Use --${name}=<value> for a value that starts with --.`,
            false,
          );
        }
        raw = next;
        index += 1;
      }
      value = decodeValue(flag, name, raw);
    }
    const current = values.get(flag);
    if (flag.repeatable) {
      if (Array.isArray(current)) current.push(value);
      else values.set(flag, [value]);
    } else if (current === undefined) {
      values.set(flag, value);
    } else {
      throw new CliUsageError(
        `Flag --${flag.name} was provided more than once.`,
        false,
      );
    }
  }
  return Object.fromEntries(
    table.flags.flatMap((flag) =>
      values.has(flag) ? [[flag.property, values.get(flag)] as const] : [],
    ),
  );
}
