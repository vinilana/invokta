import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  InstallerFileSystem,
  InstallerPathInspection,
} from "./file-system.js";
import { InstallerError } from "./installer-error.js";
import type { ToggleStrategy } from "./jcs-fingerprint.js";
import {
  contractOwnerValid,
  createPosixPathContract,
  ownerAccepted,
  type PathContractName,
  type PathSafetyContract,
} from "./path-contract.js";
import {
  type ConfigurationTargetId,
  configurationTargetIds,
  type StdioTransport,
  type StreamableHttpTransport,
} from "./registry.js";
import type { InstallerEnvironment } from "./target-config-evidence.js";

export interface StateTargetContract {
  readonly configPath: string;
  readonly targetContractVersion: 1;
  readonly toggleStrategy: ToggleStrategy;
}

export type StateTargetContracts = Readonly<
  Record<ConfigurationTargetId, StateTargetContract>
>;

export interface SuspendedDescriptor {
  readonly name: string;
  readonly transport: StdioTransport | StreamableHttpTransport;
}

export interface ManagedInstallation {
  readonly entryId: string;
  readonly registryVersion: string;
  readonly targetId: ConfigurationTargetId;
  readonly configPath: string;
  readonly serverName: string;
  readonly definitionSha256: string;
  readonly targetContractVersion: 1;
  readonly toggleStrategy: ToggleStrategy;
  /**
   * The path-safety contract in force when this record was written. Absent on
   * records written before contracts were named, which are POSIX by history.
   */
  readonly pathContract?: PathContractName;
  readonly launchDescriptor?: SuspendedDescriptor;
  readonly suspendedDescriptor?: SuspendedDescriptor;
  readonly adopted: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
}

export interface InstallerState {
  readonly schemaVersion: 1;
  readonly installations: Readonly<Record<string, ManagedInstallation>>;
}

export type StateIssueCode =
  | "BOM_FORBIDDEN"
  | "CONFIG_PATH_RELOCATED"
  | "DUPLICATE_INSTALLATION"
  | "DUPLICATE_KEY"
  | "DUPLICATE_VALUE"
  | "EMPTY_STRING"
  | "INSTALLATIONS_TOO_LARGE"
  | "INVALID_DIGEST"
  | "INVALID_ENV_NAME"
  | "INVALID_HEADER_NAME"
  | "INVALID_ID"
  | "INVALID_JSON"
  | "INVALID_PATH_CONTRACT"
  | "INVALID_SCHEMA_VERSION"
  | "INVALID_SERVER_NAME"
  | "INVALID_STRING"
  | "INVALID_TARGET_CONTRACT_VERSION"
  | "INVALID_TIMESTAMP"
  | "INVALID_TOGGLE_STRATEGY"
  | "INVALID_TRANSPORT"
  | "INVALID_TYPE"
  | "INVALID_URL"
  | "INVALID_UTF8"
  | "KEY_MISMATCH"
  | "MISSING_KEY"
  | "RESERVED_HEADER"
  | "STATE_TOO_LARGE"
  | "SUSPENDED_DESCRIPTOR_FORBIDDEN"
  | "SUSPENDED_DESCRIPTOR_MISMATCH"
  | "TIMESTAMP_ORDER"
  | "TOGGLE_STRATEGY_MISMATCH"
  | "UNKNOWN_KEY";

export interface StateIssue {
  readonly pointer: string;
  readonly code: StateIssueCode;
}

export type InstallerStateValidationResult =
  | { readonly ok: true; readonly state: InstallerState }
  | { readonly ok: false; readonly issues: readonly StateIssue[] };

export interface LoadInstallerStateOptions {
  readonly allowUnavailableTargetContracts?: boolean;
  readonly currentUserId: number | undefined;
  /** Defaults to the POSIX contract for `currentUserId`. */
  readonly contract?: PathSafetyContract;
  readonly environment: InstallerEnvironment;
  readonly fileSystem: InstallerFileSystem;
  readonly homeDirectory: string;
  readonly targetContracts: StateTargetContracts;
}

export interface LoadedInstallerState {
  readonly path: string;
  readonly state: InstallerState;
}

type JsonRecord = Record<string, unknown>;

const stateByteLimit = 16_777_216;
const installationLimit = 11_000;
const stringLimit = 4_096;
const idPattern = /^[a-z][a-z0-9-]{0,127}$/u;
const serverNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const environmentNamePattern = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const httpFieldNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/u;
const rootKeys = new Set(["schemaVersion", "installations"]);
const installationKeys = new Set([
  "entryId",
  "registryVersion",
  "targetId",
  "configPath",
  "serverName",
  "definitionSha256",
  "targetContractVersion",
  "toggleStrategy",
  "pathContract",
  "launchDescriptor",
  "suspendedDescriptor",
  "adopted",
  "installedAt",
  "updatedAt",
]);
const suspendedKeys = new Set(["name", "transport"]);
const stdioKeys = new Set(["type", "command", "args", "forwardEnv"]);
const httpKeys = new Set(["type", "url", "authentication", "headersFromEnv"]);
const authenticationNoneKeys = new Set(["type"]);
const authenticationBearerKeys = new Set(["type", "variable"]);
const reservedHeaderNames = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

class StateValidationFailure extends Error {
  readonly issues: readonly StateIssue[];

  constructor(issues: readonly StateIssue[]) {
    super("The installer state failed internal validation.");
    this.name = "StateValidationFailure";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPointer(parent: string, segment: string): string {
  return `${parent}/${escapePointer(segment)}`;
}

function addIssue(
  issues: StateIssue[],
  pointer: string,
  code: StateIssueCode,
): void {
  issues.push({ pointer, code });
}

function orderedIssues(issues: readonly StateIssue[]): readonly StateIssue[] {
  const unique = new Map<string, StateIssue>();
  for (const issue of issues) {
    unique.set(`${issue.pointer}\0${issue.code}`, issue);
  }
  return Object.freeze(
    [...unique.values()]
      .sort((left, right) =>
        left.pointer === right.pointer
          ? left.code < right.code
            ? -1
            : left.code === right.code
              ? 0
              : 1
          : left.pointer < right.pointer
            ? -1
            : 1,
      )
      .map((issue) => Object.freeze({ ...issue })),
  );
}

function invalid(
  issues: readonly StateIssue[],
): InstallerStateValidationResult {
  return { ok: false, issues: orderedIssues(issues) };
}

function hasValidUnicode(value: string, maximumScalars = stringLimit): boolean {
  let scalarCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
    scalarCount += 1;
    if (scalarCount > maximumScalars) return false;
  }
  return true;
}

function validateString(
  value: unknown,
  pointer: string,
  issues: StateIssue[],
  options: { readonly nonempty?: boolean } = {},
): value is string {
  if (typeof value !== "string") {
    addIssue(issues, pointer, "INVALID_TYPE");
    return false;
  }
  if (!hasValidUnicode(value)) addIssue(issues, pointer, "INVALID_STRING");
  if (options.nonempty === true && value.trim() === "") {
    addIssue(issues, pointer, "EMPTY_STRING");
  }
  return true;
}

function validateShape(
  value: unknown,
  pointer: string,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  issues: StateIssue[],
): value is JsonRecord {
  if (!isRecord(value)) {
    addIssue(issues, pointer, "INVALID_TYPE");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!hasValidUnicode(key)) {
      addIssue(issues, childPointer(pointer, key), "INVALID_STRING");
    }
    if (!allowed.has(key)) {
      addIssue(issues, childPointer(pointer, key), "UNKNOWN_KEY");
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      addIssue(issues, childPointer(pointer, key), "MISSING_KEY");
    }
  }
  return true;
}

function validateStringArray(
  value: unknown,
  pointer: string,
  maximum: number,
  environmentNames: boolean,
  issues: StateIssue[],
): value is string[] {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > maximum) {
    addIssue(issues, pointer, "INVALID_TYPE");
    return false;
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const itemPointer = childPointer(pointer, String(index));
    const item = value[index];
    if (!validateString(item, itemPointer, issues)) continue;
    if (environmentNames && seen.has(item)) {
      addIssue(issues, itemPointer, "DUPLICATE_VALUE");
    }
    seen.add(item);
    if (environmentNames && !environmentNamePattern.test(item)) {
      addIssue(issues, itemPointer, "INVALID_ENV_NAME");
    }
  }
  return true;
}

function validateUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator <= 0) return false;
  const authorityTail = value.slice(schemeSeparator + 3);
  const authorityEnd = authorityTail.search(/[/?#]/u);
  const authority = authorityTail.slice(
    0,
    authorityEnd === -1 ? undefined : authorityEnd,
  );
  const rawTarget =
    authorityEnd === -1 ? "" : authorityTail.slice(authorityEnd);
  const queryOrFragment = rawTarget.search(/[?#]/u);
  const rawPath = rawTarget.slice(
    0,
    queryOrFragment === -1 ? undefined : queryOrFragment,
  );
  const rawHost = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : authority.split(":", 1)[0];
  if (
    authority === "" ||
    authority.includes("@") ||
    parsed.hostname === "" ||
    rawPath !== "/mcp" ||
    parsed.pathname !== "/mcp" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }
  if (
    parsed.protocol === "http:" &&
    rawHost !== "127.0.0.1" &&
    rawHost !== "[::1]"
  ) {
    return false;
  }
  return true;
}

function validateAuthentication(
  value: unknown,
  pointer: string,
  issues: StateIssue[],
): "none" | "bearer-env" | undefined {
  if (value === undefined) return "none";
  if (!isRecord(value)) {
    addIssue(issues, pointer, "INVALID_TYPE");
    return undefined;
  }
  if (value.type === "none") {
    validateShape(value, pointer, authenticationNoneKeys, ["type"], issues);
    return "none";
  }
  if (value.type === "bearer-env") {
    validateShape(
      value,
      pointer,
      authenticationBearerKeys,
      ["type", "variable"],
      issues,
    );
    const variablePointer = childPointer(pointer, "variable");
    if (
      validateString(value.variable, variablePointer, issues) &&
      !environmentNamePattern.test(value.variable)
    ) {
      addIssue(issues, variablePointer, "INVALID_ENV_NAME");
    }
    return "bearer-env";
  }
  validateShape(value, pointer, authenticationNoneKeys, ["type"], issues);
  addIssue(issues, childPointer(pointer, "type"), "INVALID_TRANSPORT");
  return undefined;
}

function validateHeaders(
  value: unknown,
  pointer: string,
  authentication: "none" | "bearer-env" | undefined,
  issues: StateIssue[],
): value is JsonRecord | undefined {
  if (value === undefined) return true;
  if (!isRecord(value) || Object.keys(value).length > 64) {
    addIssue(issues, pointer, "INVALID_TYPE");
    return false;
  }
  const seen = new Set<string>();
  for (const name of Object.keys(value)) {
    const headerPointer = childPointer(pointer, name);
    const normalized = name.toLowerCase();
    validateString(name, headerPointer, issues);
    if (!httpFieldNamePattern.test(name)) {
      addIssue(issues, headerPointer, "INVALID_HEADER_NAME");
    }
    if (seen.has(normalized)) {
      addIssue(issues, headerPointer, "DUPLICATE_VALUE");
    }
    seen.add(normalized);
    if (
      reservedHeaderNames.has(normalized) ||
      (authentication === "bearer-env" && normalized === "authorization")
    ) {
      addIssue(issues, headerPointer, "RESERVED_HEADER");
    }
    const environmentName = value[name];
    if (
      validateString(environmentName, headerPointer, issues) &&
      !environmentNamePattern.test(environmentName)
    ) {
      addIssue(issues, headerPointer, "INVALID_ENV_NAME");
    }
  }
  return true;
}

function validateTransport(
  value: unknown,
  pointer: string,
  issues: StateIssue[],
): value is JsonRecord {
  if (!isRecord(value)) {
    addIssue(issues, pointer, "INVALID_TYPE");
    return false;
  }
  if (value.type === "stdio") {
    validateShape(value, pointer, stdioKeys, ["type", "command"], issues);
    const commandPointer = childPointer(pointer, "command");
    if (validateString(value.command, commandPointer, issues)) {
      if (value.command === "")
        addIssue(issues, commandPointer, "EMPTY_STRING");
      if (value.command.includes("\0")) {
        addIssue(issues, commandPointer, "INVALID_STRING");
      }
    }
    validateStringArray(
      value.args,
      childPointer(pointer, "args"),
      128,
      false,
      issues,
    );
    validateStringArray(
      value.forwardEnv,
      childPointer(pointer, "forwardEnv"),
      64,
      true,
      issues,
    );
    return true;
  }
  if (value.type === "streamable-http") {
    validateShape(value, pointer, httpKeys, ["type", "url"], issues);
    const urlPointer = childPointer(pointer, "url");
    if (
      validateString(value.url, urlPointer, issues) &&
      !validateUrl(value.url)
    ) {
      addIssue(issues, urlPointer, "INVALID_URL");
    }
    const authentication = validateAuthentication(
      value.authentication,
      childPointer(pointer, "authentication"),
      issues,
    );
    validateHeaders(
      value.headersFromEnv,
      childPointer(pointer, "headersFromEnv"),
      authentication,
      issues,
    );
    return true;
  }
  validateShape(value, pointer, new Set(["type"]), ["type"], issues);
  addIssue(issues, childPointer(pointer, "type"), "INVALID_TRANSPORT");
  return false;
}

interface ParsedTimestamp {
  readonly fields: readonly number[];
  readonly fraction: string;
}

function parseTimestamp(value: string): ParsedTimestamp | undefined {
  const match = timestampPattern.exec(value);
  if (match === null) return undefined;
  const fields = match.slice(1, 7).map(Number);
  const [year, month, day, hour, minute, second] = fields;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day < 1 || day > (monthLengths[month - 1] as number)) return undefined;
  return { fields, fraction: match[7] ?? "" };
}

function compareTimestamps(
  left: ParsedTimestamp,
  right: ParsedTimestamp,
): number {
  for (let index = 0; index < left.fields.length; index += 1) {
    const difference =
      (left.fields[index] as number) - (right.fields[index] as number);
    if (difference !== 0) return difference;
  }
  const length = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(length, "0");
  const rightFraction = right.fraction.padEnd(length, "0");
  return leftFraction < rightFraction
    ? -1
    : leftFraction === rightFraction
      ? 0
      : 1;
}

export function isInstallerTimestampAfter(
  candidate: string,
  previous: string,
): boolean {
  const candidateTimestamp = parseTimestamp(candidate);
  const previousTimestamp = parseTimestamp(previous);
  return (
    candidateTimestamp !== undefined &&
    previousTimestamp !== undefined &&
    compareTimestamps(candidateTimestamp, previousTimestamp) > 0
  );
}

function normalizeTransport(
  value: JsonRecord,
): StdioTransport | StreamableHttpTransport {
  if (value.type === "stdio") {
    return Object.freeze({
      type: "stdio",
      command: value.command as string,
      args: Object.freeze([...((value.args as string[] | undefined) ?? [])]),
      forwardEnv: Object.freeze([
        ...((value.forwardEnv as string[] | undefined) ?? []),
      ]),
    });
  }
  const rawAuthentication = value.authentication as JsonRecord | undefined;
  const authentication =
    rawAuthentication?.type === "bearer-env"
      ? Object.freeze({
          type: "bearer-env" as const,
          variable: rawAuthentication.variable as string,
        })
      : Object.freeze({ type: "none" as const });
  const headers: Record<string, string> = {};
  for (const [name, environmentName] of Object.entries(
    (value.headersFromEnv as JsonRecord | undefined) ?? {},
  ).sort(([left], [right]) => (left < right ? -1 : left === right ? 0 : 1))) {
    headers[name.toLowerCase()] = environmentName as string;
  }
  return Object.freeze({
    type: "streamable-http",
    url: new URL(value.url as string).href,
    authentication,
    headersFromEnv: Object.freeze(headers),
  });
}

function normalizeInstallation(value: JsonRecord): ManagedInstallation {
  const rawLaunch = value.launchDescriptor as JsonRecord | undefined;
  const launchDescriptor =
    rawLaunch === undefined
      ? undefined
      : Object.freeze({
          name: rawLaunch.name as string,
          transport: normalizeTransport(rawLaunch.transport as JsonRecord),
        });
  const rawSuspended = value.suspendedDescriptor as JsonRecord | undefined;
  const suspendedDescriptor =
    rawSuspended === undefined
      ? undefined
      : Object.freeze({
          name: rawSuspended.name as string,
          transport: normalizeTransport(rawSuspended.transport as JsonRecord),
        });
  return Object.freeze({
    entryId: value.entryId as string,
    registryVersion: value.registryVersion as string,
    targetId: value.targetId as ConfigurationTargetId,
    configPath: value.configPath as string,
    serverName: value.serverName as string,
    definitionSha256: value.definitionSha256 as string,
    targetContractVersion: 1,
    toggleStrategy: value.toggleStrategy as ToggleStrategy,
    ...(value.pathContract === undefined
      ? {}
      : { pathContract: value.pathContract as PathContractName }),
    ...(launchDescriptor === undefined ? {} : { launchDescriptor }),
    ...(suspendedDescriptor === undefined ? {} : { suspendedDescriptor }),
    adopted: value.adopted as boolean,
    installedAt: value.installedAt as string,
    updatedAt: value.updatedAt as string,
  });
}

function validateSuspendedDescriptor(
  value: unknown,
  pointer: string,
  serverName: unknown,
  issues: StateIssue[],
): void {
  if (
    !validateShape(value, pointer, suspendedKeys, ["name", "transport"], issues)
  ) {
    return;
  }
  const namePointer = childPointer(pointer, "name");
  if (validateString(value.name, namePointer, issues)) {
    if (!serverNamePattern.test(value.name)) {
      addIssue(issues, namePointer, "INVALID_SERVER_NAME");
    }
    if (typeof serverName === "string" && value.name !== serverName) {
      addIssue(issues, namePointer, "SUSPENDED_DESCRIPTOR_MISMATCH");
    }
  }
  validateTransport(
    value.transport,
    childPointer(pointer, "transport"),
    issues,
  );
}

function validateInstallation(
  key: string,
  value: unknown,
  pointer: string,
  targetContracts: StateTargetContracts,
  allowUnavailableTargetContracts: boolean,
  seenPairs: Set<string>,
  issues: StateIssue[],
): value is JsonRecord {
  if (
    !validateShape(
      value,
      pointer,
      installationKeys,
      [
        "entryId",
        "registryVersion",
        "targetId",
        "configPath",
        "serverName",
        "definitionSha256",
        "targetContractVersion",
        "toggleStrategy",
        "adopted",
        "installedAt",
        "updatedAt",
      ],
      issues,
    )
  ) {
    return false;
  }

  if (
    validateString(value.entryId, childPointer(pointer, "entryId"), issues) &&
    !idPattern.test(value.entryId)
  ) {
    addIssue(issues, childPointer(pointer, "entryId"), "INVALID_ID");
  }
  validateString(
    value.registryVersion,
    childPointer(pointer, "registryVersion"),
    issues,
    { nonempty: true },
  );
  // Absent means a record written before contracts were named, which is POSIX
  // by history. Present means it must be a contract this build knows.
  if (
    value.pathContract !== undefined &&
    value.pathContract !== "posix" &&
    value.pathContract !== "windows"
  ) {
    addIssue(
      issues,
      childPointer(pointer, "pathContract"),
      "INVALID_PATH_CONTRACT",
    );
  }
  const validTargetId =
    typeof value.targetId === "string" &&
    configurationTargetIds.includes(value.targetId as ConfigurationTargetId);
  if (!validTargetId) {
    addIssue(issues, childPointer(pointer, "targetId"), "INVALID_ID");
  }
  const configPath = value.configPath;
  const configPathValid = validateString(
    configPath,
    childPointer(pointer, "configPath"),
    issues,
  );
  if (
    configPathValid &&
    (!isAbsolute(configPath) || configPath.includes("\0"))
  ) {
    addIssue(issues, childPointer(pointer, "configPath"), "INVALID_STRING");
  }
  if (
    validateString(
      value.serverName,
      childPointer(pointer, "serverName"),
      issues,
    ) &&
    !serverNamePattern.test(value.serverName)
  ) {
    addIssue(
      issues,
      childPointer(pointer, "serverName"),
      "INVALID_SERVER_NAME",
    );
  }
  if (
    validateString(
      value.definitionSha256,
      childPointer(pointer, "definitionSha256"),
      issues,
    ) &&
    !digestPattern.test(value.definitionSha256)
  ) {
    addIssue(
      issues,
      childPointer(pointer, "definitionSha256"),
      "INVALID_DIGEST",
    );
  }
  if (value.targetContractVersion !== 1) {
    addIssue(
      issues,
      childPointer(pointer, "targetContractVersion"),
      "INVALID_TARGET_CONTRACT_VERSION",
    );
  }
  const validToggleStrategy =
    value.toggleStrategy === "native-enabled" ||
    value.toggleStrategy === "native-disabled" ||
    value.toggleStrategy === "detached";
  if (!validToggleStrategy) {
    addIssue(
      issues,
      childPointer(pointer, "toggleStrategy"),
      "INVALID_TOGGLE_STRATEGY",
    );
  }
  if (typeof value.adopted !== "boolean") {
    addIssue(issues, childPointer(pointer, "adopted"), "INVALID_TYPE");
  }

  const installedAt =
    typeof value.installedAt === "string"
      ? parseTimestamp(value.installedAt)
      : undefined;
  const updatedAt =
    typeof value.updatedAt === "string"
      ? parseTimestamp(value.updatedAt)
      : undefined;
  if (installedAt === undefined) {
    addIssue(issues, childPointer(pointer, "installedAt"), "INVALID_TIMESTAMP");
  }
  if (updatedAt === undefined) {
    addIssue(issues, childPointer(pointer, "updatedAt"), "INVALID_TIMESTAMP");
  }
  if (
    installedAt !== undefined &&
    updatedAt !== undefined &&
    compareTimestamps(updatedAt, installedAt) < 0
  ) {
    addIssue(issues, childPointer(pointer, "updatedAt"), "TIMESTAMP_ORDER");
  }

  if (
    typeof value.entryId === "string" &&
    typeof value.targetId === "string" &&
    typeof value.configPath === "string"
  ) {
    if (
      key !==
      installationKey(
        value.entryId,
        value.targetId as ConfigurationTargetId,
        value.configPath,
      )
    ) {
      addIssue(issues, pointer, "KEY_MISMATCH");
    }
    const pair = `${value.entryId}\0${value.targetId}`;
    if (seenPairs.has(pair))
      addIssue(issues, pointer, "DUPLICATE_INSTALLATION");
    seenPairs.add(pair);
  }

  if (validTargetId) {
    const contract = targetContracts[value.targetId as ConfigurationTargetId];
    if (contract === undefined && allowUnavailableTargetContracts) {
      // Status still validates intrinsic state when a target cannot be detected.
    } else if (!isRecord(contract) || contract.targetContractVersion !== 1) {
      addIssue(
        issues,
        childPointer(pointer, "targetId"),
        "INVALID_TARGET_CONTRACT_VERSION",
      );
    } else if (
      !isAbsolute(contract.configPath) ||
      contract.configPath.includes("\0") ||
      resolve(contract.configPath) !== contract.configPath
    ) {
      addIssue(
        issues,
        childPointer(pointer, "configPath"),
        "CONFIG_PATH_RELOCATED",
      );
    } else {
      if (value.configPath !== contract.configPath) {
        addIssue(
          issues,
          childPointer(pointer, "configPath"),
          "CONFIG_PATH_RELOCATED",
        );
      }
      if (value.toggleStrategy !== contract.toggleStrategy) {
        addIssue(
          issues,
          childPointer(pointer, "toggleStrategy"),
          "TOGGLE_STRATEGY_MISMATCH",
        );
      }
    }
  }

  if (value.suspendedDescriptor !== undefined) {
    if (value.toggleStrategy !== "detached") {
      addIssue(
        issues,
        childPointer(pointer, "suspendedDescriptor"),
        "SUSPENDED_DESCRIPTOR_FORBIDDEN",
      );
    }
    validateSuspendedDescriptor(
      value.suspendedDescriptor,
      childPointer(pointer, "suspendedDescriptor"),
      value.serverName,
      issues,
    );
  }
  if (value.launchDescriptor !== undefined) {
    validateSuspendedDescriptor(
      value.launchDescriptor,
      childPointer(pointer, "launchDescriptor"),
      value.serverName,
      issues,
    );
  }
  return true;
}

interface JsonToken {
  readonly kind: "string" | "punctuation" | "scalar";
  readonly value?: string;
  readonly end: number;
}

function nextJsonToken(text: string, start: number): JsonToken | undefined {
  let index = start;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  if (index >= text.length) return undefined;
  const character = text[index] as string;
  if (character === '"') {
    let end = index + 1;
    while (end < text.length) {
      if (text[end] === "\\") end += 2;
      else if (text[end++] === '"') break;
    }
    return {
      kind: "string",
      value: JSON.parse(text.slice(index, end)) as string,
      end,
    };
  }
  if ("{}[]:,".includes(character)) {
    return { kind: "punctuation", value: character, end: index + 1 };
  }
  let end = index + 1;
  while (
    end < text.length &&
    !(/\s/u.test(text[end] as string) || "{}[],:".includes(text[end] as string))
  ) {
    end += 1;
  }
  return { kind: "scalar", end };
}

type JsonFrame =
  | {
      readonly kind: "object";
      readonly pointer: string;
      readonly keys: Set<string>;
      state: "key" | "colon" | "value" | "comma";
      key?: string;
    }
  | {
      readonly kind: "array";
      readonly pointer: string;
      state: "value" | "comma";
      index: number;
    };

function duplicateKeyIssues(text: string): StateIssue[] {
  const issues: StateIssue[] = [];
  const stack: JsonFrame[] = [];
  let offset = 0;
  let rootConsumed = false;

  const consumeValue = (token: JsonToken, pointer: string): void => {
    const parent = stack.at(-1);
    if (parent === undefined) rootConsumed = true;
    else if (parent.kind === "object") {
      parent.state = "comma";
      delete parent.key;
    } else {
      parent.state = "comma";
      parent.index += 1;
    }
    if (token.kind !== "punctuation") return;
    if (token.value === "{") {
      stack.push({ kind: "object", pointer, keys: new Set(), state: "key" });
    } else if (token.value === "[") {
      stack.push({ kind: "array", pointer, state: "value", index: 0 });
    }
  };

  while (true) {
    const token = nextJsonToken(text, offset);
    if (token === undefined) break;
    offset = token.end;
    const frame = stack.at(-1);
    if (frame === undefined) {
      if (!rootConsumed) consumeValue(token, "");
      continue;
    }
    if (frame.kind === "object") {
      if (frame.state === "key") {
        if (token.kind === "punctuation" && token.value === "}") stack.pop();
        else if (token.kind === "string") {
          const key = token.value as string;
          if (frame.keys.has(key)) {
            addIssue(issues, childPointer(frame.pointer, key), "DUPLICATE_KEY");
          }
          frame.keys.add(key);
          frame.key = key;
          frame.state = "colon";
        }
      } else if (frame.state === "colon") frame.state = "value";
      else if (frame.state === "value") {
        consumeValue(token, childPointer(frame.pointer, frame.key as string));
      } else if (token.kind === "punctuation" && token.value === ",") {
        frame.state = "key";
      } else if (token.kind === "punctuation" && token.value === "}")
        stack.pop();
    } else if (frame.state === "value") {
      if (token.kind === "punctuation" && token.value === "]") stack.pop();
      else
        consumeValue(token, childPointer(frame.pointer, String(frame.index)));
    } else if (token.kind === "punctuation" && token.value === ",") {
      frame.state = "value";
    } else if (token.kind === "punctuation" && token.value === "]") stack.pop();
  }
  return issues;
}

export function installationKey(
  entryId: string,
  targetId: ConfigurationTargetId,
  configPath: string,
): string {
  return `${entryId}\0${targetId}\0${configPath}`;
}

export function createEmptyInstallerState(): InstallerState {
  return Object.freeze({
    schemaVersion: 1,
    installations: Object.freeze({}),
  });
}

export function validateInstallerStateBytes(
  bytes: Uint8Array,
  targetContracts: StateTargetContracts,
  options: { readonly allowUnavailableTargetContracts?: boolean } = {},
): InstallerStateValidationResult {
  if (bytes.byteLength > stateByteLimit) {
    return invalid([{ pointer: "", code: "STATE_TOO_LARGE" }]);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return invalid([{ pointer: "", code: "BOM_FORBIDDEN" }]);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return invalid([{ pointer: "", code: "INVALID_UTF8" }]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return invalid([{ pointer: "", code: "INVALID_JSON" }]);
  }

  const issues = duplicateKeyIssues(text);
  if (
    !validateShape(
      parsed,
      "",
      rootKeys,
      ["schemaVersion", "installations"],
      issues,
    )
  ) {
    return invalid(issues);
  }
  if (parsed.schemaVersion !== 1) {
    addIssue(issues, "/schemaVersion", "INVALID_SCHEMA_VERSION");
  }
  if (!isRecord(parsed.installations)) {
    addIssue(issues, "/installations", "INVALID_TYPE");
    return invalid(issues);
  }
  const entries = Object.entries(parsed.installations);
  if (entries.length > installationLimit) {
    addIssue(issues, "/installations", "INSTALLATIONS_TOO_LARGE");
  }
  const seenPairs = new Set<string>();
  const validInstallations: Array<readonly [string, JsonRecord]> = [];
  const installationsPointer = "/installations";
  for (const [key, value] of entries) {
    const recordPointer = childPointer(installationsPointer, key);
    if (!hasValidUnicode(key, Number.POSITIVE_INFINITY))
      addIssue(issues, recordPointer, "INVALID_STRING");
    if (
      validateInstallation(
        key,
        value,
        recordPointer,
        targetContracts,
        options.allowUnavailableTargetContracts === true,
        seenPairs,
        issues,
      )
    ) {
      validInstallations.push([key, value]);
    }
  }
  if (issues.length > 0) return invalid(issues);

  const installations: Record<string, ManagedInstallation> = {};
  for (const [key, value] of validInstallations) {
    Object.defineProperty(installations, key, {
      configurable: false,
      enumerable: true,
      value: normalizeInstallation(value),
      writable: false,
    });
  }
  return {
    ok: true,
    state: Object.freeze({
      schemaVersion: 1,
      installations: Object.freeze(installations),
    }),
  };
}

function inside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
}

type StatePathInspection = "missing" | "present";

async function inspectStatePath(
  fileSystem: InstallerFileSystem,
  contract: PathSafetyContract,
  basePath: string,
  statePath: string,
  requireExactBaseRealPath: boolean,
): Promise<StatePathInspection> {
  const difference = relative(basePath, statePath);
  const components = [basePath];
  let componentPath = basePath;
  for (const component of difference.split(sep)) {
    componentPath = join(componentPath, component);
    components.push(componentPath);
  }

  let previousRealPath: string | undefined;
  for (const [index, path] of components.entries()) {
    let inspection: InstallerPathInspection;
    try {
      inspection = await fileSystem.inspectPath(path);
    } catch (cause) {
      throw new InstallerError("STATE_READ_FAILED", cause);
    }
    if (inspection.kind === "missing") return "missing";
    if (
      !ownerAccepted(contract, inspection.ownerId) ||
      inspection.kind === "symbolic-link" ||
      inspection.kind === "other"
    ) {
      throw new InstallerError("STATE_INVALID");
    }
    const isTarget = index === components.length - 1;
    if (inspection.kind !== (isTarget ? "regular-file" : "directory")) {
      throw new InstallerError("STATE_INVALID");
    }
    if (
      !isAbsolute(inspection.realPath) ||
      inspection.realPath.includes("\0")
    ) {
      throw new InstallerError("STATE_INVALID");
    }
    const realPath = resolve(inspection.realPath);
    if (index === 0) {
      if (requireExactBaseRealPath && realPath !== basePath) {
        throw new InstallerError("STATE_INVALID");
      }
    } else if (
      previousRealPath === undefined ||
      dirname(realPath) !== previousRealPath
    ) {
      throw new InstallerError("STATE_INVALID");
    }
    previousRealPath = realPath;
  }
  return "present";
}

export async function loadInstallerState(
  options: LoadInstallerStateOptions,
): Promise<LoadedInstallerState> {
  const contract =
    options.contract ??
    (options.currentUserId === undefined
      ? undefined
      : createPosixPathContract(options.currentUserId));
  if (
    contract === undefined ||
    !contractOwnerValid(contract) ||
    !isAbsolute(options.homeDirectory) ||
    options.homeDirectory.includes("\0")
  ) {
    throw new InstallerError("STATE_INVALID");
  }

  let xdgStateHome: unknown;
  try {
    xdgStateHome = options.environment.get("XDG_STATE_HOME");
  } catch (cause) {
    throw new InstallerError("STATE_INVALID", cause);
  }
  const usesXdg = xdgStateHome !== undefined;
  if (
    usesXdg &&
    (typeof xdgStateHome !== "string" ||
      xdgStateHome.trim() === "" ||
      xdgStateHome.includes("\0") ||
      !isAbsolute(xdgStateHome))
  ) {
    throw new InstallerError("STATE_INVALID");
  }
  const basePath = resolve(
    usesXdg
      ? (xdgStateHome as string)
      : join(options.homeDirectory, ".local", "state"),
  );
  const homePath = resolve(options.homeDirectory);
  // A contract without ownership evidence has only containment left, so the
  // state file may not leave the profile it is meant to belong to.
  if (contract.confinesToUserProfile && !inside(homePath, basePath)) {
    throw new InstallerError("STATE_INVALID");
  }
  const inspectionBase = usesXdg ? basePath : homePath;
  const path = join(basePath, "invokta", "installer.json");
  const inspection = await inspectStatePath(
    options.fileSystem,
    contract,
    inspectionBase,
    path,
    usesXdg,
  );
  if (inspection === "missing") {
    return Object.freeze({ path, state: createEmptyInstallerState() });
  }

  let bytes: Uint8Array;
  try {
    bytes = await options.fileSystem.readFile(pathToFileURL(path));
  } catch (cause) {
    throw new InstallerError("STATE_READ_FAILED", cause);
  }
  const result = validateInstallerStateBytes(bytes, options.targetContracts, {
    allowUnavailableTargetContracts:
      options.allowUnavailableTargetContracts === true,
  });
  if (!result.ok) {
    throw new InstallerError(
      "STATE_INVALID",
      new StateValidationFailure(result.issues),
    );
  }
  return Object.freeze({ path, state: result.state });
}
