import type { CapabilityDescription } from "@invokta/core";

import {
  type CapabilityFlag,
  type CapabilityFlags,
  displayProperty,
  type FlagScalar,
  type InputOnlyProperty,
} from "./flags.js";

/** Flag and input-only property lines listed on one capability page. */
const maximumHelpEntries = 100;
/** Characters kept from each rendered text field before `...`. */
const maximumHelpTextLength = 500;
/** Allowed `enum` or `const` values listed for one flag. */
const maximumAllowedValues = 20;

const annotationNames = [
  "readOnly",
  "destructive",
  "idempotent",
  "openWorld",
] as const;

// Whitespace, C0 and C1 controls, and bidirectional formatting characters
// collapse to one space so author text cannot inject terminal sequences or
// break the line structure.
function isSeparator(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    /\s/u.test(character)
  );
}

/** Sanitizes author text to one trimmed line of bounded length. */
function text(value: string): string {
  let result = "";
  let length = 0;
  let pendingSpace = false;
  for (const character of value) {
    if (isSeparator(character)) {
      pendingSpace = length > 0;
      continue;
    }
    if (length >= maximumHelpTextLength - (pendingSpace ? 1 : 0)) {
      return `${result}...`;
    }
    if (pendingSpace) {
      result += " ";
      length += 1;
      pendingSpace = false;
    }
    result += character;
    length += 1;
  }
  return result;
}

function renderValue(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z0-9_.:/@+-]+$/u.test(value)) {
    return value;
  }
  return JSON.stringify(value) ?? "null";
}

function renderAllowed(values: readonly FlagScalar[]): string {
  const shown = values.slice(0, maximumAllowedValues).map(renderValue);
  const omitted = values.length - shown.length;
  return omitted > 0
    ? `${shown.join(", ")}, and ${String(omitted)} more`
    : shown.join(", ");
}

function renderFlag(flag: CapabilityFlag): string[] {
  const spelling =
    flag.type === "boolean"
      ? `--${flag.name}, --no-${flag.name}`
      : `--${flag.name} <${flag.type}>`;
  const markers = [
    ...(flag.required ? ["required"] : []),
    ...(flag.repeatable ? ["repeatable"] : []),
  ];
  return [
    `  ${spelling}${markers.length === 0 ? "" : ` (${markers.join(", ")})`}`,
    ...(flag.description === undefined
      ? []
      : [`      ${text(flag.description)}`]),
    ...(flag.allowed === undefined
      ? []
      : [`      Allowed: ${text(renderAllowed(flag.allowed))}`]),
    ...(flag.default === undefined
      ? []
      : [`      Default: ${text(renderValue(flag.default.value))}`]),
  ];
}

function renderInputOnly(entry: InputOnlyProperty): string {
  return `  ${text(displayProperty(entry.property))} (${entry.reason}${entry.required ? ", required" : ""})`;
}

function renderAnnotations(annotations: unknown): string[] {
  if (typeof annotations !== "object" || annotations === null) return [];
  const record = annotations as Readonly<Record<string, unknown>>;
  const rendered = annotationNames.flatMap((name) => {
    const value = record[name];
    return typeof value === "boolean" ? [`${name}=${String(value)}`] : [];
  });
  return rendered.length === 0 ? [] : [`Annotations: ${rendered.join(", ")}`];
}

/** Renders the deterministic, bounded human-readable page of one capability. */
export function renderCapabilityHelp(
  description: CapabilityDescription,
  table: CapabilityFlags,
): string {
  const id = text(String(description.id));
  const shownFlags = table.flags.slice(0, maximumHelpEntries);
  const shownInputOnly = table.inputOnly.slice(
    0,
    maximumHelpEntries - shownFlags.length,
  );
  const omitted =
    table.flags.length +
    table.inputOnly.length -
    shownFlags.length -
    shownInputOnly.length;
  const lines = [
    `Capability: ${id}`,
    ...(typeof description.title === "string"
      ? [`Title: ${text(description.title)}`]
      : []),
    ...(typeof description.description === "string"
      ? [`Description: ${text(description.description)}`]
      : []),
    ...renderAnnotations(description.annotations),
    "",
    "Usage:",
    ...(table.flags.length === 0 ? [] : [`  engine run ${id} [flags]`]),
    `  engine run ${id} --input '<json>'`,
    `  engine run ${id} --stdin`,
    "",
    "Flags:",
    ...(table.flags.length === 0 ? ["  (none)"] : []),
    ...shownFlags.flatMap(renderFlag),
    ...(shownInputOnly.length === 0
      ? []
      : [
          "",
          "Use --input or --stdin for:",
          ...shownInputOnly.map(renderInputOnly),
        ]),
    ...(omitted > 0
      ? [
          `  ... and ${String(omitted)} more properties. Run "engine describe ${id}" for the full input schema.`,
        ]
      : []),
    "",
    "Flags build one JSON input object that the capability's input schema",
    "validates. Use --input or --stdin for values that flags cannot express.",
  ];
  return `${lines.join("\n")}\n`;
}
