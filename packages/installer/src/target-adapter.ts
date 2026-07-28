import { InstallerError } from "./installer-error.js";
import type { SuspendedDescriptor } from "./installer-state.js";
import {
  canonicalizeJcs,
  registerCanonicalJcs,
  type ToggleStrategy,
} from "./jcs-fingerprint.js";
import type {
  CapabilityInstallDescriptor,
  ConfigurationTargetId,
  RegistryCompatibility,
} from "./registry.js";

export const targetConfigByteLimit = 4_194_304;

export interface TargetAdapterCounters {
  sourceDecodePasses: number;
  sourceParsePasses: number;
  inspectionPasses: number;
  patchConstructionPasses: number;
  postImageEncodePasses: number;
  postImageDecodePasses: number;
  postImageParsePasses: number;
}

export function createTargetAdapterCounters(): TargetAdapterCounters {
  return {
    sourceDecodePasses: 0,
    sourceParsePasses: 0,
    inspectionPasses: 0,
    patchConstructionPasses: 0,
    postImageEncodePasses: 0,
    postImageDecodePasses: 0,
    postImageParsePasses: 0,
  };
}

export interface TargetAdapterMetadata {
  readonly targetId: ConfigurationTargetId;
  readonly targetContractVersion: 1;
  readonly format: "json" | "json5" | "jsonc" | "toml" | "yaml";
  readonly parentPath: readonly string[];
  readonly toggleStrategy: ToggleStrategy;
}

export type CurrentTargetServer =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly definition: Readonly<Record<string, unknown>>;
    };

export const targetInspectionState = Symbol("targetInspectionState");
export const targetDefinitionCanonicals = Symbol("targetDefinitionCanonicals");

export interface TargetDefinitionCanonicals {
  readonly current: string;
  readonly enabled?: string;
  readonly disabled?: string;
}

export interface TargetConfigInspection {
  readonly currentServer: CurrentTargetServer;
  readonly [targetInspectionState]: unknown;
  readonly [targetDefinitionCanonicals]: TargetDefinitionCanonicals | undefined;
}

export function frozenTargetInspection(
  currentServer: CurrentTargetServer,
  state: unknown,
  canonicals: TargetDefinitionCanonicals | undefined,
): TargetConfigInspection {
  const inspection = {
    currentServer: Object.freeze(currentServer),
  } as TargetConfigInspection;
  Object.defineProperties(inspection, {
    [targetDefinitionCanonicals]: {
      configurable: false,
      enumerable: false,
      value: canonicals,
      writable: false,
    },
    [targetInspectionState]: {
      configurable: false,
      enumerable: false,
      value: state,
      writable: false,
    },
  });
  return Object.freeze(inspection);
}

export type TargetPatchRequest =
  | {
      readonly action: "install";
      readonly definition: Readonly<Record<string, unknown>>;
      readonly inspection: TargetConfigInspection;
      readonly counters?: TargetAdapterCounters;
    }
  | {
      readonly action: "enable";
      readonly restoreDefinition?: Readonly<Record<string, unknown>>;
      readonly inspection: TargetConfigInspection;
      readonly counters?: TargetAdapterCounters;
    }
  | {
      readonly action: "disable";
      readonly inspection: TargetConfigInspection;
      readonly counters?: TargetAdapterCounters;
    };

export type TargetPatch =
  | { readonly kind: "unchanged" }
  | { readonly kind: "changed"; readonly postImage: Uint8Array };

export interface TargetAdapter {
  readonly metadata: TargetAdapterMetadata;
  readonly compatibility: (
    descriptor: CapabilityInstallDescriptor,
  ) => RegistryCompatibility;
  readonly descriptorToDefinition: (
    descriptor: CapabilityInstallDescriptor,
  ) => Readonly<Record<string, unknown>>;
  readonly suspendedDescriptorToDefinition: (
    descriptor: SuspendedDescriptor,
  ) => Readonly<Record<string, unknown>>;
  readonly inspect: (input: {
    readonly source: Uint8Array | undefined;
    readonly serverName: string;
    readonly counters?: TargetAdapterCounters;
  }) => TargetConfigInspection;
  readonly constructPatch: (request: TargetPatchRequest) => TargetPatch;
}

export interface DecodedTargetSource {
  readonly bytes: Uint8Array | undefined;
  readonly text: string;
  readonly bom: boolean;
  readonly newline: "\n" | "\r\n";
  readonly trailingNewline: boolean;
  readonly missing: boolean;
}

const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf]);

function hasLeadingBom(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 3 &&
    bytes[0] === utf8Bom[0] &&
    bytes[1] === utf8Bom[1] &&
    bytes[2] === utf8Bom[2]
  );
}

export function decodeTargetSource(
  bytes: Uint8Array | undefined,
  counters: TargetAdapterCounters | undefined,
  phase: "source" | "post-image",
): DecodedTargetSource {
  if (bytes === undefined) {
    return {
      bytes,
      text: "",
      bom: false,
      newline: "\n",
      trailingNewline: true,
      missing: true,
    };
  }
  if (bytes.byteLength > targetConfigByteLimit) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  const bom = hasLeadingBom(bytes);
  const payload = bom ? bytes.subarray(3) : bytes;
  if (phase === "source") {
    if (counters !== undefined) counters.sourceDecodePasses += 1;
  } else if (counters !== undefined) {
    counters.postImageDecodePasses += 1;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      payload,
    );
  } catch (cause) {
    throw new InstallerError("HARNESS_CONFIG_INVALID", cause);
  }
  if (text.includes("\ufeff")) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  return {
    bytes,
    text,
    bom,
    newline: text.includes("\r\n") ? "\r\n" : "\n",
    trailingNewline: text.endsWith("\n"),
    missing: false,
  };
}

export function encodeTargetPostImage(
  text: string,
  bom: boolean,
  counters: TargetAdapterCounters | undefined,
): Uint8Array {
  if (counters !== undefined) counters.postImageEncodePasses += 1;
  const payload = new TextEncoder().encode(text);
  const length = payload.byteLength + (bom ? utf8Bom.byteLength : 0);
  if (length > targetConfigByteLimit) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  if (!bom) return payload;
  const bytes = new Uint8Array(length);
  bytes.set(utf8Bom);
  bytes.set(payload, utf8Bom.byteLength);
  return bytes;
}

export function parsePass(
  counters: TargetAdapterCounters | undefined,
  phase: "source" | "post-image",
): void {
  if (counters === undefined) return;
  if (phase === "source") counters.sourceParsePasses += 1;
  else counters.postImageParsePasses += 1;
}

export function inspectionPass(
  counters: TargetAdapterCounters | undefined,
): void {
  if (counters !== undefined) counters.inspectionPasses += 1;
}

export function patchPass(counters: TargetAdapterCounters | undefined): void {
  if (counters !== undefined) counters.patchConstructionPasses += 1;
}

export type InspectedJsonValue =
  | {
      readonly kind: "scalar";
      readonly value: unknown;
      readonly canonical: string | undefined;
    }
  | {
      readonly kind: "array";
      readonly value: readonly unknown[];
      readonly items: readonly InspectedJsonValue[];
      readonly allStrings: boolean;
      readonly canonical: string | undefined;
    }
  | InspectedJsonRecord;

export interface InspectedJsonRecord {
  readonly kind: "record";
  readonly value: Record<string, unknown>;
  readonly fields: Map<string, InspectedJsonValue>;
  readonly allStringValues: boolean;
  readonly canonical: string | undefined;
}

function invalidInspectedJson(cause?: unknown): never {
  throw new InstallerError("HARNESS_CONFIG_INVALID", cause);
}

function serializeInspectedString(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        invalidInspectedJson();
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalidInspectedJson();
    }
  }
  return JSON.stringify(value);
}

export function inspectedJsonScalar(
  value: unknown,
  selected: boolean,
): InspectedJsonValue {
  if (!selected) return { kind: "scalar", value, canonical: undefined };
  let canonical: string;
  if (value === null) canonical = "null";
  else if (typeof value === "boolean") canonical = String(value);
  else if (typeof value === "string")
    canonical = serializeInspectedString(value);
  else if (typeof value === "number" && Number.isFinite(value)) {
    canonical = JSON.stringify(value);
  } else invalidInspectedJson();
  return { kind: "scalar", value, canonical };
}

export function inspectedJsonArray(
  items: readonly InspectedJsonValue[],
  selected: boolean,
): InspectedJsonValue {
  const value = new Array<unknown>(items.length);
  const canonicalItems = selected ? new Array<string>(items.length) : undefined;
  let allStrings = true;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] as InspectedJsonValue;
    value[index] = item.value;
    if (typeof item.value !== "string") allStrings = false;
    if (selected) {
      if (item.canonical === undefined) invalidInspectedJson();
      (canonicalItems as string[])[index] = item.canonical;
    }
  }
  return {
    kind: "array",
    value: selected ? Object.freeze(value) : value,
    items,
    allStrings,
    canonical: selected
      ? `[${(canonicalItems as string[]).join(",")}]`
      : undefined,
  };
}

export function inspectedJsonRecord(
  fields: Map<string, InspectedJsonValue>,
  selected: boolean,
  mutable = false,
): InspectedJsonRecord {
  const value = Object.create(null) as Record<string, unknown>;
  let allStringValues = true;
  const keys = selected ? [...fields.keys()].sort() : [...fields.keys()];
  const canonicalParts: string[] = [];
  for (const key of keys) {
    const field = fields.get(key) ?? invalidInspectedJson();
    if (typeof field.value !== "string") allStringValues = false;
    Object.defineProperty(value, key, {
      configurable: mutable,
      enumerable: true,
      value: field.value,
      writable: mutable,
    });
    if (selected) {
      if (field.canonical === undefined) invalidInspectedJson();
      canonicalParts.push(
        `${serializeInspectedString(key)}:${field.canonical}`,
      );
    }
  }
  if (selected && !mutable) Object.freeze(value);
  return {
    kind: "record",
    value,
    fields,
    allStringValues,
    canonical: selected ? `{${canonicalParts.join(",")}}` : undefined,
  };
}

function canonicalRootVariants(
  fields: ReadonlyMap<string, InspectedJsonValue>,
  toggleStrategy: ToggleStrategy,
): TargetDefinitionCanonicals & {
  readonly withoutEnabled?: string;
  readonly withoutDisabled?: string;
} {
  const current: string[] = [];
  const enabled: string[] = [];
  const disabled: string[] = [];
  const withoutToggle: string[] = [];
  const toggleField =
    toggleStrategy === "native-enabled"
      ? "enabled"
      : toggleStrategy === "native-disabled"
        ? "disabled"
        : undefined;
  for (const key of [...fields.keys()].sort()) {
    const field = fields.get(key) ?? invalidInspectedJson();
    if (field.canonical === undefined) invalidInspectedJson();
    const prefix = `${serializeInspectedString(key)}:`;
    current.push(`${prefix}${field.canonical}`);
    if (key === toggleField) {
      enabled.push(
        `${prefix}${toggleStrategy === "native-enabled" ? "true" : "false"}`,
      );
      disabled.push(
        `${prefix}${toggleStrategy === "native-enabled" ? "false" : "true"}`,
      );
    } else if (toggleField !== undefined) {
      enabled.push(`${prefix}${field.canonical}`);
      disabled.push(`${prefix}${field.canonical}`);
      withoutToggle.push(`${prefix}${field.canonical}`);
    }
  }
  return Object.freeze({
    current: `{${current.join(",")}}`,
    ...(toggleField !== undefined
      ? {
          enabled: `{${enabled.join(",")}}`,
          disabled: `{${disabled.join(",")}}`,
          ...(toggleStrategy === "native-enabled"
            ? { withoutEnabled: `{${withoutToggle.join(",")}}` }
            : { withoutDisabled: `{${withoutToggle.join(",")}}` }),
        }
      : {}),
  });
}

function setInspectedField(
  root: InspectedJsonRecord,
  key: string,
  field: InspectedJsonValue,
): void {
  Object.defineProperty(root.value, key, {
    configurable: true,
    enumerable: true,
    value: field.value,
    writable: true,
  });
  root.fields.set(key, field);
}

export function finalizeInspectedMcpDefinition(
  root: InspectedJsonRecord,
  options: {
    readonly stdioEnvironmentField?: string;
    readonly stdioEnvironmentKind?: "array" | "object";
    readonly httpHeadersField?: string;
    readonly httpBearerTokenField?: string;
    readonly httpUrlField?: string;
    readonly rawTransportPolicy: "reject" | "allow-openclaw-http";
    readonly toggleStrategy?: ToggleStrategy;
    readonly typePolicy?: "none" | "claude";
  },
): {
  readonly definition: Readonly<Record<string, unknown>>;
  readonly canonicals: TargetDefinitionCanonicals;
} {
  const command = root.fields.get("command")?.value;
  const httpUrlField = options.httpUrlField ?? "url";
  const url = root.fields.get(httpUrlField)?.value;
  const isStdio = typeof command === "string" && url === undefined;
  const isHttp = typeof url === "string" && command === undefined;
  if (!isStdio && !isHttp) invalidInspectedJson();
  const transport = isStdio ? "stdio" : "streamable-http";
  const existingTransport = root.fields.get("transport");
  if (
    existingTransport !== undefined &&
    (options.rawTransportPolicy === "reject" ||
      !isHttp ||
      existingTransport.value !== "streamable-http")
  ) {
    invalidInspectedJson();
  }
  setInspectedField(root, "transport", inspectedJsonScalar(transport, true));

  if (options.typePolicy === "claude") {
    const type = root.fields.get("type");
    const accepted = isStdio
      ? type === undefined || type.value === "stdio"
      : type !== undefined &&
        (type.value === "http" || type.value === "streamable-http");
    if (!accepted) invalidInspectedJson();
    setInspectedField(
      root,
      "type",
      inspectedJsonScalar(isStdio ? "stdio" : "http", true),
    );
  }

  const toggleStrategy = options.toggleStrategy ?? "native-enabled";
  const toggleField =
    toggleStrategy === "native-enabled"
      ? "enabled"
      : toggleStrategy === "native-disabled"
        ? "disabled"
        : undefined;
  if (toggleField !== undefined) {
    const toggle = root.fields.get(toggleField);
    if (toggle === undefined) {
      setInspectedField(
        root,
        toggleField,
        inspectedJsonScalar(toggleStrategy === "native-enabled", true),
      );
    } else if (typeof toggle.value !== "boolean") invalidInspectedJson();
  }

  if (isStdio) {
    const args = root.fields.get("args");
    if (args === undefined) {
      setInspectedField(root, "args", inspectedJsonArray([], true));
    } else if (args.kind !== "array" || !args.allStrings) {
      invalidInspectedJson();
    }
    if (options.stdioEnvironmentField !== undefined) {
      const environment = root.fields.get(options.stdioEnvironmentField);
      if (environment === undefined) {
        setInspectedField(
          root,
          options.stdioEnvironmentField,
          options.stdioEnvironmentKind === "array"
            ? inspectedJsonArray([], true)
            : inspectedJsonRecord(new Map(), true),
        );
      } else if (
        options.stdioEnvironmentKind === "array"
          ? environment.kind !== "array" || !environment.allStrings
          : environment.kind !== "record" || !environment.allStringValues
      ) {
        invalidInspectedJson();
      }
    }
  } else {
    if (options.httpHeadersField !== undefined) {
      const headers = root.fields.get(options.httpHeadersField);
      if (headers === undefined) {
        setInspectedField(
          root,
          options.httpHeadersField,
          inspectedJsonRecord(new Map(), true),
        );
      } else if (headers.kind !== "record" || !headers.allStringValues) {
        invalidInspectedJson();
      }
    }
    if (options.httpBearerTokenField !== undefined) {
      const bearerToken = root.fields.get(options.httpBearerTokenField);
      if (bearerToken !== undefined && typeof bearerToken.value !== "string") {
        invalidInspectedJson();
      }
    }
  }

  Object.freeze(root.value);
  const variants = canonicalRootVariants(root.fields, toggleStrategy);
  const canonicals = Object.freeze({
    current: variants.current,
    ...(variants.enabled === undefined ? {} : { enabled: variants.enabled }),
    ...(variants.disabled === undefined ? {} : { disabled: variants.disabled }),
  });
  registerCanonicalJcs(root.value, {
    full: canonicals.current,
    ...(variants.withoutEnabled === undefined
      ? {}
      : { withoutEnabled: variants.withoutEnabled }),
    ...(variants.withoutDisabled === undefined
      ? {}
      : { withoutDisabled: variants.withoutDisabled }),
  });
  return { definition: root.value, canonicals };
}

export function assertTargetInspectionConsistency(
  inspection: TargetConfigInspection,
): TargetDefinitionCanonicals | undefined {
  const currentServer = inspection.currentServer;
  const canonicals = inspection[targetDefinitionCanonicals];
  if (currentServer.kind === "absent") {
    if (canonicals !== undefined) {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
    return undefined;
  }
  if (currentServer.kind !== "present" || canonicals === undefined) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  try {
    if (canonicalizeJcs(currentServer.definition) !== canonicals.current) {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
  } catch (cause) {
    if (cause instanceof InstallerError) throw cause;
    throw new InstallerError("HARNESS_CONFIG_INVALID", cause);
  }
  return canonicals;
}

export function assertPostImageDefinition(
  request: TargetPatchRequest,
  postInspection: TargetConfigInspection,
  toggleStrategy: ToggleStrategy = "native-enabled",
): void {
  const postCanonicals = assertTargetInspectionConsistency(postInspection);
  if (toggleStrategy === "detached" && request.action === "disable") {
    if (
      postInspection.currentServer.kind !== "absent" ||
      postCanonicals !== undefined
    ) {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
    return;
  }
  if (
    postInspection.currentServer.kind !== "present" ||
    postCanonicals === undefined
  ) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  const postCanonical = postCanonicals.current;
  let expectedCanonical: string;
  if (request.action === "install") {
    try {
      expectedCanonical = canonicalizeJcs(request.definition);
    } catch (cause) {
      throw new InstallerError("HARNESS_CONFIG_INVALID", cause);
    }
  } else if (toggleStrategy === "detached") {
    if (
      request.action !== "enable" ||
      request.restoreDefinition === undefined
    ) {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
    try {
      expectedCanonical = canonicalizeJcs(request.restoreDefinition);
    } catch (cause) {
      throw new InstallerError("HARNESS_CONFIG_INVALID", cause);
    }
  } else {
    if (request.inspection.currentServer.kind !== "present") {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
    const sourceCanonicals = assertTargetInspectionConsistency(
      request.inspection,
    );
    if (sourceCanonicals === undefined) {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
    const variant =
      request.action === "enable"
        ? sourceCanonicals.enabled
        : sourceCanonicals.disabled;
    if (variant === undefined) {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
    expectedCanonical = variant;
  }
  if (postCanonical !== expectedCanonical) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
}

export function assertServerName(serverName: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(serverName)) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
}

function cloneJson(value: unknown, depth: number): unknown {
  if (depth > 100) throw new InstallerError("HARNESS_CONFIG_INVALID");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneJson(item, depth + 1)));
  }
  if (typeof value !== "object" || value === undefined) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  if (
    Object.getOwnPropertySymbols(value).some(
      (symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable,
    )
  ) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      value: cloneJson(descriptor.value, depth + 1),
      writable: false,
    });
  }
  return Object.freeze(result);
}

export function normalizedCurrentDefinition(
  raw: unknown,
): Readonly<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  const cloned = cloneJson(raw, 1) as Readonly<Record<string, unknown>>;
  const enabledDescriptor = Object.getOwnPropertyDescriptor(cloned, "enabled");
  if (
    enabledDescriptor !== undefined &&
    (!("value" in enabledDescriptor) ||
      typeof enabledDescriptor.value !== "boolean")
  ) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  const normalized =
    enabledDescriptor === undefined
      ? Object.freeze({ ...cloned, enabled: true })
      : cloned;
  try {
    const canonical = canonicalizeJcs(normalized);
    registerCanonicalJcs(normalized, { full: canonical });
  } catch (cause) {
    throw new InstallerError("HARNESS_CONFIG_INVALID", cause);
  }
  return normalized;
}

export function normalizedDetachedDefinition(
  raw: unknown,
): Readonly<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  const normalized = cloneJson(raw, 1) as Readonly<Record<string, unknown>>;
  try {
    const canonical = canonicalizeJcs(normalized);
    registerCanonicalJcs(normalized, { full: canonical });
  } catch (cause) {
    throw new InstallerError("HARNESS_CONFIG_INVALID", cause);
  }
  return normalized;
}

export function normalizedMcpDefinition(
  raw: unknown,
  options: {
    readonly stdioEnvironmentField: string;
    readonly stdioEnvironmentKind: "array" | "object";
    readonly httpHeadersField: string;
    readonly rawTransportPolicy: "reject" | "allow-openclaw-http";
  },
): Readonly<Record<string, unknown>> {
  const definition = normalizedCurrentDefinition(raw);
  const isStdio =
    typeof definition.command === "string" && definition.url === undefined;
  const isHttp =
    typeof definition.url === "string" && definition.command === undefined;
  if (!isStdio && !isHttp) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  const transport = isStdio ? "stdio" : "streamable-http";
  if (
    Object.hasOwn(definition, "transport") &&
    (options.rawTransportPolicy === "reject" ||
      !isHttp ||
      definition.transport !== "streamable-http")
  ) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  const normalized: Record<string, unknown> = {
    ...definition,
    transport,
  };
  if (isStdio) {
    if (normalized.args === undefined) normalized.args = [];
    if (
      !Array.isArray(normalized.args) ||
      normalized.args.some((argument) => typeof argument !== "string")
    ) {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
    const environment = normalized[options.stdioEnvironmentField];
    if (environment === undefined) {
      normalized[options.stdioEnvironmentField] =
        options.stdioEnvironmentKind === "array" ? [] : {};
    } else if (
      options.stdioEnvironmentKind === "array"
        ? !Array.isArray(environment) ||
          environment.some((name) => typeof name !== "string")
        : typeof environment !== "object" ||
          environment === null ||
          Array.isArray(environment) ||
          Object.values(environment).some((value) => typeof value !== "string")
    ) {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
    return freezeDefinition(normalized);
  }

  const value = definition[options.httpHeadersField];
  if (value === undefined) {
    normalized[options.httpHeadersField] = {};
    return freezeDefinition(normalized);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  const normalizedKeys = new Set<string>();
  const fields: Record<string, unknown> = {};
  for (const [name, fieldValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (typeof fieldValue !== "string") {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
    const normalizedName = name.toLowerCase();
    if (normalizedKeys.has(normalizedName)) {
      throw new InstallerError("HARNESS_CONFIG_INVALID");
    }
    normalizedKeys.add(normalizedName);
    fields[normalizedName] = fieldValue;
  }
  normalized[options.httpHeadersField] = fields;
  return freezeDefinition(normalized);
}

export function freezeDefinition(
  definition: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  return normalizedCurrentDefinition(definition);
}

export function freezeDetachedDefinition(
  definition: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  return normalizedDetachedDefinition(definition);
}

export function readOwn(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  return value as Record<string, unknown>;
}

export function unsupportedDefinition(): never {
  throw new InstallerError("TARGET_UNSUPPORTED");
}
