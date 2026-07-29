import {
  type ArrayNode,
  type DocumentNode,
  type MemberNode,
  type ObjectNode,
  parse,
  type Token,
  type ValueNode,
} from "@humanwhocodes/momoa";

import { InstallerError } from "./installer-error.js";
import { canonicalizeJcs, type ToggleStrategy } from "./jcs-fingerprint.js";
import type {
  CapabilityInstallDescriptor,
  ConfigurationTargetId,
} from "./registry.js";
import {
  assertPostImageDefinition,
  assertServerName,
  assertTargetInspectionConsistency,
  type DecodedTargetSource,
  decodeTargetSource,
  encodeTargetPostImage,
  finalizeInspectedMcpDefinition,
  freezeDefinition,
  freezeDetachedDefinition,
  frozenTargetInspection,
  type InspectedJsonValue,
  inspectedJsonArray,
  inspectedJsonRecord,
  inspectedJsonScalar,
  inspectionPass,
  parsePass,
  patchPass,
  type TargetAdapter,
  type TargetAdapterCounters,
  type TargetConfigInspection,
  type TargetPatch,
  type TargetPatchRequest,
  targetInspectionStateFor,
  unsupportedDefinition,
} from "./target-adapter.js";

type JsonDialect =
  | "antigravity"
  | "claude"
  | "cursor"
  | "kimi"
  | "opencode"
  | "vscode";

interface JsonInspectionState {
  readonly dialect: JsonDialect;
  readonly source: DecodedTargetSource;
  readonly serverName: string;
  readonly root: ObjectNode | undefined;
  readonly mcp: ObjectNode | undefined;
  readonly servers: ObjectNode | undefined;
  readonly serverMember: MemberNode | undefined;
  readonly server: ObjectNode | undefined;
  readonly toggle: ValueNode | undefined;
  readonly members: ReadonlyMap<ObjectNode, ReadonlyMap<string, MemberNode>>;
  readonly tokens: readonly Token[];
}

interface AstInspection {
  readonly members: ReadonlyMap<ObjectNode, ReadonlyMap<string, MemberNode>>;
  readonly values: ReadonlyMap<ValueNode, InspectedJsonValue>;
}

interface JsonTargetOptions {
  readonly targetId: Extract<
    ConfigurationTargetId,
    | "antigravity"
    | "claude-code"
    | "claude-desktop"
    | "cursor"
    | "kimi-code"
    | "opencode-v2"
    | "vscode"
  >;
  readonly dialect: JsonDialect;
  readonly toggleStrategy: ToggleStrategy;
  readonly compatibility: TargetAdapter["compatibility"];
  readonly descriptorToDefinition: TargetAdapter["descriptorToDefinition"];
  readonly definitionToSuspendedDescriptor: TargetAdapter["definitionToSuspendedDescriptor"];
}

function invalid(cause?: unknown): never {
  throw new InstallerError("HARNESS_CONFIG_INVALID", cause);
}

function range(node: {
  readonly range?: readonly [number, number];
}): readonly [number, number] {
  if (node.range === undefined) invalid();
  return node.range;
}

function scalarValue(node: ValueNode): unknown {
  switch (node.type) {
    case "Null":
      return null;
    case "Boolean":
    case "String":
    case "Number":
      return node.value;
    default:
      return invalid();
  }
}

function memberName(member: MemberNode): string {
  return member.name.type === "Identifier"
    ? member.name.name
    : member.name.value;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function selectedPath(
  path: readonly string[],
  serverPath: readonly string[],
): boolean {
  return (
    path.length >= serverPath.length &&
    serverPath.every((segment, index) => segment === path[index])
  );
}

function serverPath(
  dialect: JsonDialect,
  serverName: string,
): readonly string[] {
  return dialect === "opencode"
    ? ["mcp", "servers", serverName]
    : dialect === "vscode"
      ? ["servers", serverName]
      : ["mcpServers", serverName];
}

function inspectAst(
  document: DocumentNode,
  serverName: string,
  dialect: JsonDialect,
): AstInspection {
  const members = new Map<ObjectNode, ReadonlyMap<string, MemberNode>>();
  const values = new Map<ValueNode, InspectedJsonValue>();
  const selectedServerPath = serverPath(dialect, serverName);
  type Task =
    | {
        readonly kind: "visit";
        readonly node: ValueNode;
        readonly depth: number;
        readonly path: readonly string[];
        readonly assign: (assigned: InspectedJsonValue) => void;
      }
    | {
        readonly kind: "finish-array";
        readonly node: ArrayNode;
        readonly path: readonly string[];
        readonly items: InspectedJsonValue[];
        readonly assign: (assigned: InspectedJsonValue) => void;
      }
    | {
        readonly kind: "finish-object";
        readonly node: ObjectNode;
        readonly path: readonly string[];
        readonly fields: Map<string, InspectedJsonValue>;
        readonly assign: (assigned: InspectedJsonValue) => void;
      };
  const stack: Task[] = [
    {
      kind: "visit",
      node: document.body,
      depth: 1,
      path: [],
      assign: () => undefined,
    },
  ];

  while (stack.length > 0) {
    const task = stack.pop() as Task;
    if (task.kind === "finish-array") {
      const inspected = inspectedJsonArray(
        task.items,
        selectedPath(task.path, selectedServerPath),
      );
      values.set(task.node, inspected);
      task.assign(inspected);
      continue;
    }
    if (task.kind === "finish-object") {
      const inspected = inspectedJsonRecord(
        task.fields,
        selectedPath(task.path, selectedServerPath),
        samePath(task.path, selectedServerPath),
      );
      values.set(task.node, inspected);
      task.assign(inspected);
      continue;
    }

    const { node, depth, path, assign } = task;
    if (node.type === "Object") {
      if (depth > 100) invalid();
      const objectMembers = new Map<string, MemberNode>();
      const fields = new Map<string, InspectedJsonValue>();
      members.set(node, objectMembers);
      stack.push({ kind: "finish-object", node, path, fields, assign });
      for (let index = node.members.length - 1; index >= 0; index -= 1) {
        const member = node.members[index] as MemberNode;
        const name = memberName(member);
        if (objectMembers.has(name)) invalid();
        objectMembers.set(name, member);
        const child = member.value;
        const normalizedName = samePath(path, [
          ...selectedServerPath,
          "headers",
        ])
          ? name.toLowerCase()
          : name;
        if (fields.has(normalizedName)) invalid();
        stack.push({
          kind: "visit",
          node: child,
          depth:
            child.type === "Object" || child.type === "Array"
              ? depth + 1
              : depth,
          path: [...path, name],
          assign: (assigned) => {
            if (fields.has(normalizedName)) invalid();
            fields.set(normalizedName, assigned);
          },
        });
      }
      continue;
    }
    if (node.type === "Array") {
      if (depth > 100) invalid();
      const items = new Array<InspectedJsonValue>(node.elements.length);
      stack.push({ kind: "finish-array", node, path, items, assign });
      for (let index = node.elements.length - 1; index >= 0; index -= 1) {
        const child = node.elements[index]?.value;
        if (child === undefined) invalid();
        stack.push({
          kind: "visit",
          node: child,
          depth:
            child.type === "Object" || child.type === "Array"
              ? depth + 1
              : depth,
          path,
          assign: (assigned) => {
            items[index] = assigned;
          },
        });
      }
      continue;
    }
    const inspected = inspectedJsonScalar(
      scalarValue(node),
      selectedPath(path, selectedServerPath),
    );
    values.set(node, inspected);
    assign(inspected);
  }
  return { members, values };
}

function objectMember(
  state: Pick<JsonInspectionState, "members">,
  object: ObjectNode | undefined,
  key: string,
): MemberNode | undefined {
  return object === undefined ? undefined : state.members.get(object)?.get(key);
}

function objectValue(
  state: Pick<JsonInspectionState, "members">,
  object: ObjectNode | undefined,
  key: string,
): ValueNode | undefined {
  return objectMember(state, object, key)?.value;
}

function objectNode(node: ValueNode | undefined): ObjectNode | undefined {
  if (node === undefined) return undefined;
  if (node.type !== "Object") invalid();
  return node;
}

function finalizationOptions(
  dialect: JsonDialect,
  toggleStrategy: ToggleStrategy,
) {
  if (dialect === "antigravity") {
    return {
      httpUrlField: "serverUrl",
      rawTransportPolicy: "reject" as const,
      toggleStrategy,
      typePolicy: "none" as const,
    };
  }
  if (dialect === "kimi") {
    return {
      httpBearerTokenField: "bearerTokenEnvVar",
      rawTransportPolicy: "reject" as const,
      toggleStrategy,
      typePolicy: "none" as const,
    };
  }
  if (dialect === "opencode") {
    return {
      stdioCommandKind: "array" as const,
      stdioEnvironmentField: "environment",
      stdioEnvironmentKind: "object" as const,
      httpHeadersField: "headers",
      rawTransportPolicy: "reject" as const,
      toggleStrategy,
      typePolicy: "opencode" as const,
    };
  }
  return {
    stdioEnvironmentField: "env",
    stdioEnvironmentKind: "object" as const,
    httpHeadersField: "headers",
    rawTransportPolicy: "reject" as const,
    toggleStrategy,
    typePolicy:
      dialect === "claude" || dialect === "vscode"
        ? ("claude" as const)
        : ("none" as const),
  };
}

function emptyState(
  source: DecodedTargetSource,
  serverName: string,
  dialect: JsonDialect,
): JsonInspectionState {
  return Object.freeze({
    dialect,
    source,
    serverName,
    root: undefined,
    mcp: undefined,
    servers: undefined,
    serverMember: undefined,
    server: undefined,
    toggle: undefined,
    members: new Map(),
    tokens: Object.freeze([]),
  });
}

function parseAndInspect(
  sourceBytes: Uint8Array | undefined,
  serverName: string,
  counters: TargetAdapterCounters | undefined,
  phase: "source" | "post-image",
  options: Pick<JsonTargetOptions, "dialect" | "toggleStrategy">,
  inspectionOwner: object,
): TargetConfigInspection {
  assertServerName(serverName);
  const source = decodeTargetSource(sourceBytes, counters, phase);
  if (source.missing) {
    if (phase === "source") inspectionPass(counters);
    return frozenTargetInspection(
      { kind: "absent" },
      emptyState(source, serverName, options.dialect),
      undefined,
      inspectionOwner,
    );
  }

  parsePass(counters, phase);
  let document: DocumentNode;
  let astInspection: AstInspection;
  try {
    document = parse(source.text, {
      mode:
        options.dialect === "opencode" || options.dialect === "vscode"
          ? "jsonc"
          : "json",
      ranges: true,
      tokens: true,
      ...(options.dialect === "opencode" || options.dialect === "vscode"
        ? { allowTrailingCommas: true }
        : {}),
    });
    astInspection = inspectAst(document, serverName, options.dialect);
  } catch (cause) {
    if (cause instanceof InstallerError) throw cause;
    return invalid(cause);
  }
  if (document.body.type !== "Object") invalid();
  const root = document.body;
  const memberState = { members: astInspection.members };
  const mcp =
    options.dialect === "opencode"
      ? objectNode(objectValue(memberState, root, "mcp"))
      : undefined;
  const servers = objectNode(
    objectValue(
      memberState,
      options.dialect === "opencode" ? mcp : root,
      options.dialect === "opencode" || options.dialect === "vscode"
        ? "servers"
        : "mcpServers",
    ),
  );
  const serverMember = objectMember(memberState, servers, serverName);
  const server = objectNode(serverMember?.value);
  const inspectedServer =
    server === undefined ? undefined : astInspection.values.get(server);
  if (server !== undefined && inspectedServer?.kind !== "record") invalid();
  const finalized =
    inspectedServer?.kind === "record"
      ? finalizeInspectedMcpDefinition(
          inspectedServer,
          finalizationOptions(options.dialect, options.toggleStrategy),
        )
      : undefined;
  if (phase === "source") inspectionPass(counters);
  return frozenTargetInspection(
    finalized === undefined
      ? { kind: "absent" }
      : { kind: "present", definition: finalized.definition },
    Object.freeze({
      dialect: options.dialect,
      source,
      serverName,
      root,
      mcp,
      servers,
      serverMember,
      server,
      toggle: objectValue(
        memberState,
        server,
        options.toggleStrategy === "native-disabled" ? "disabled" : "enabled",
      ),
      members: astInspection.members,
      tokens: Object.freeze(document.tokens ?? []),
    } satisfies JsonInspectionState),
    finalized?.canonicals,
    inspectionOwner,
  );
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  return /^[\t ]*/u.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

function insertProperty(
  text: string,
  object: ObjectNode,
  key: string,
  value: string,
  newline: string,
  tokens: readonly Token[],
): string {
  const [start, end] = range(object);
  const close = end - 1;
  const inside = text.slice(start + 1, close);
  const last = object.members.at(-1);
  if (last === undefined) {
    if (inside.includes("\n")) {
      const closeIndent = lineIndent(text, close);
      const insertionStart = close - closeIndent.length;
      return `${text.slice(0, insertionStart)}${closeIndent}  ${JSON.stringify(key)}: ${value}${newline}${text.slice(insertionStart)}`;
    }
    return `${text.slice(0, close)}${inside.trim() === "" ? "" : " "}${JSON.stringify(key)}: ${value}${inside.trim() === "" ? "" : " "}${text.slice(close)}`;
  }
  const [, lastEnd] = range(last.value);
  const hasTrailingComma = tokens.some((token) => {
    if (token.type !== "Comma") return false;
    const [start, end] = range(token);
    return start >= lastEnd && end <= close;
  });
  const withComma = hasTrailingComma
    ? text
    : `${text.slice(0, lastEnd)},${text.slice(lastEnd)}`;
  const adjustedClose = close + (hasTrailingComma ? 0 : 1);
  if (inside.includes("\n")) {
    const closeIndent = lineIndent(withComma, adjustedClose);
    const insertionStart = adjustedClose - closeIndent.length;
    return `${withComma.slice(0, insertionStart)}${closeIndent}  ${JSON.stringify(key)}: ${value}${newline}${withComma.slice(insertionStart)}`;
  }
  return `${withComma.slice(0, adjustedClose)} ${JSON.stringify(key)}: ${value}${withComma.slice(adjustedClose)}`;
}

function replaceRange(
  text: string,
  node: ValueNode,
  replacement: string,
): string {
  const [start, end] = range(node);
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

function removeMember(
  text: string,
  state: JsonInspectionState,
  object: ObjectNode,
  member: MemberNode,
): string {
  const index = object.members.indexOf(member);
  if (index < 0) invalid();
  const [memberStart, memberEnd] = range(member);
  if (object.members.length === 1) {
    return `${text.slice(0, memberStart)}${text.slice(memberEnd)}`;
  }
  if (index < object.members.length - 1) {
    const [nextStart] = range(object.members[index + 1] as MemberNode);
    return `${text.slice(0, memberStart)}${text.slice(nextStart)}`;
  }
  const previous = object.members[index - 1] as MemberNode;
  const [, previousEnd] = range(previous);
  const comma = state.tokens.find((token) => {
    if (token.type !== "Comma") return false;
    const [start, end] = range(token);
    return start >= previousEnd && end <= memberStart;
  });
  if (comma === undefined) invalid();
  const [commaStart] = range(comma);
  return `${text.slice(0, commaStart)}${text.slice(memberEnd)}`;
}

function mappedConfigDefinition(
  definition: Readonly<Record<string, unknown>>,
  dialect: JsonDialect,
): Readonly<Record<string, unknown>> {
  const stdio = definition.transport === "stdio";
  const keys =
    dialect === "antigravity"
      ? stdio
        ? ["command", "args", "disabled"]
        : ["serverUrl", "disabled"]
      : dialect === "claude" || dialect === "vscode"
        ? stdio
          ? ["type", "command", "args", "env"]
          : ["type", "url", "headers"]
        : dialect === "cursor"
          ? stdio
            ? ["command", "args", "env"]
            : ["url", "headers"]
          : dialect === "kimi"
            ? stdio
              ? ["command", "args", "enabled"]
              : ["url", "bearerTokenEnvVar", "enabled"]
            : stdio
              ? ["type", "command", "environment", "disabled"]
              : ["type", "url", "oauth", "headers", "disabled"];
  const mapped: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(definition, key)) mapped[key] = definition[key];
  }
  for (const optional of ["env", "environment", "headers"] as const) {
    const value = mapped[optional];
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      delete mapped[optional];
    }
  }
  if (
    typeof mapped.headers === "object" &&
    mapped.headers !== null &&
    !Array.isArray(mapped.headers)
  ) {
    mapped.headers = Object.fromEntries(
      Object.entries(mapped.headers).map(([name, value]) => [
        name === "authorization" ? "Authorization" : name,
        value,
      ]),
    );
  }
  return mapped;
}

function stringRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

const environmentNamePattern = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const httpFieldNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const reservedHeaderNames: ReadonlySet<string> = new Set([
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

function validEnvironmentPlaceholders(
  value: unknown,
  dialect: Extract<JsonDialect, "claude" | "cursor" | "opencode" | "vscode">,
): boolean {
  if (!stringRecord(value)) return false;
  return Object.entries(value as Record<string, string>).every(
    ([name, placeholder]) =>
      environmentNamePattern.test(name) &&
      placeholder ===
        (dialect === "claude"
          ? `\${${name}}`
          : dialect === "cursor" || dialect === "vscode"
            ? `\${env:${name}}`
            : `{env:${name}}`),
  );
}

function validHeaderPlaceholders(
  value: unknown,
  dialect: Extract<JsonDialect, "claude" | "cursor" | "opencode" | "vscode">,
): boolean {
  if (!stringRecord(value)) return false;
  const barePattern =
    dialect === "claude"
      ? /^\$\{[A-Z_][A-Z0-9_]{0,127}\}$/u
      : dialect === "cursor" || dialect === "vscode"
        ? /^\$\{env:[A-Z_][A-Z0-9_]{0,127}\}$/u
        : /^\{env:[A-Z_][A-Z0-9_]{0,127}\}$/u;
  const bearerPattern =
    dialect === "claude"
      ? /^Bearer \$\{[A-Z_][A-Z0-9_]{0,127}\}$/u
      : dialect === "cursor" || dialect === "vscode"
        ? /^Bearer \$\{env:[A-Z_][A-Z0-9_]{0,127}\}$/u
        : /^Bearer \{env:[A-Z_][A-Z0-9_]{0,127}\}$/u;
  return Object.entries(value as Record<string, string>).every(
    ([name, placeholder]) =>
      name === name.toLowerCase() &&
      httpFieldNamePattern.test(name) &&
      !reservedHeaderNames.has(name) &&
      (name === "authorization"
        ? barePattern.test(placeholder) || bearerPattern.test(placeholder)
        : barePattern.test(placeholder)),
  );
}

function validateMappedDefinition(
  definition: Readonly<Record<string, unknown>>,
  dialect: JsonDialect,
): void {
  if (
    typeof definition !== "object" ||
    definition === null ||
    Array.isArray(definition)
  ) {
    invalid();
  }
  canonicalDefinition(definition);
  const stdio = definition.transport === "stdio";
  const http = definition.transport === "streamable-http";
  if (!stdio && !http) invalid();
  const allowed = new Set(
    dialect === "antigravity"
      ? stdio
        ? ["transport", "command", "args", "disabled"]
        : ["transport", "serverUrl", "disabled"]
      : dialect === "claude" || dialect === "vscode"
        ? stdio
          ? ["transport", "type", "command", "args", "env"]
          : ["transport", "type", "url", "headers"]
        : dialect === "cursor"
          ? stdio
            ? ["transport", "command", "args", "env"]
            : ["transport", "url", "headers"]
          : dialect === "kimi"
            ? stdio
              ? ["transport", "command", "args", "enabled"]
              : ["transport", "url", "bearerTokenEnvVar", "enabled"]
            : stdio
              ? ["transport", "type", "command", "environment", "disabled"]
              : ["transport", "type", "url", "oauth", "headers", "disabled"],
  );
  if (Object.keys(definition).some((key) => !allowed.has(key))) invalid();
  if (stdio) {
    if (dialect === "opencode") {
      if (
        definition.type !== "local" ||
        !Array.isArray(definition.command) ||
        definition.command.length === 0 ||
        definition.command.some((argument) => typeof argument !== "string")
      ) {
        invalid();
      }
    } else if (
      typeof definition.command !== "string" ||
      !Array.isArray(definition.args) ||
      definition.args.some((argument) => typeof argument !== "string")
    ) {
      invalid();
    }
    if (
      (dialect === "claude" || dialect === "vscode") &&
      definition.type !== "stdio"
    ) {
      invalid();
    }
    if (
      (dialect === "claude" ||
        dialect === "vscode" ||
        dialect === "cursor" ||
        dialect === "opencode") &&
      !validEnvironmentPlaceholders(
        dialect === "opencode" ? definition.environment : definition.env,
        dialect,
      )
    ) {
      invalid();
    }
  } else {
    if (
      dialect === "antigravity"
        ? typeof definition.serverUrl !== "string"
        : typeof definition.url !== "string"
    ) {
      invalid();
    }
    if (
      (dialect === "claude" || dialect === "vscode") &&
      definition.type !== "http"
    ) {
      invalid();
    }
    if (
      dialect === "opencode" &&
      (definition.type !== "remote" || definition.oauth !== false)
    ) {
      invalid();
    }
    if (
      (dialect === "claude" ||
        dialect === "vscode" ||
        dialect === "cursor" ||
        dialect === "opencode") &&
      !validHeaderPlaceholders(definition.headers, dialect)
    ) {
      invalid();
    }
    if (
      dialect === "kimi" &&
      definition.bearerTokenEnvVar !== undefined &&
      (typeof definition.bearerTokenEnvVar !== "string" ||
        !environmentNamePattern.test(definition.bearerTokenEnvVar))
    ) {
      invalid();
    }
  }
  if (dialect === "kimi" && typeof definition.enabled !== "boolean") {
    invalid();
  }
  if (dialect === "antigravity" && typeof definition.disabled !== "boolean") {
    invalid();
  }
  if (dialect === "opencode" && typeof definition.disabled !== "boolean") {
    invalid();
  }
}

function definitionJson(
  definition: Readonly<Record<string, unknown>>,
  dialect: JsonDialect,
): string {
  return JSON.stringify(mappedConfigDefinition(definition, dialect));
}

function canonicalDefinition(
  definition: Readonly<Record<string, unknown>>,
): string {
  try {
    return canonicalizeJcs(definition);
  } catch (cause) {
    throw new InstallerError("HARNESS_CONFIG_INVALID", cause);
  }
}

function constructPatch(
  request: TargetPatchRequest,
  options: Pick<JsonTargetOptions, "dialect" | "toggleStrategy">,
  inspectionOwner: object,
): TargetPatch {
  const sourceCanonicals = assertTargetInspectionConsistency(
    request.inspection,
  );
  const state = targetInspectionStateFor<JsonInspectionState>(
    request.inspection,
    inspectionOwner,
  );
  if (state.dialect !== options.dialect) invalid();

  let insertedDefinition: Readonly<Record<string, unknown>> | undefined;
  if (request.action === "install") {
    if (request.inspection.currentServer.kind === "present") {
      throw new InstallerError("CONFIG_CONFLICT");
    }
    validateMappedDefinition(request.definition, options.dialect);
    insertedDefinition = request.definition;
  } else if (request.action === "remove") {
    if (
      request.inspection.currentServer.kind !== "present" ||
      state.servers === undefined ||
      state.serverMember === undefined
    ) {
      invalid();
    }
  } else if (options.toggleStrategy === "detached") {
    if (request.action === "disable") {
      if (request.inspection.currentServer.kind === "absent") {
        return { kind: "unchanged" };
      }
    } else {
      if (request.restoreDefinition === undefined) invalid();
      validateMappedDefinition(request.restoreDefinition, options.dialect);
      insertedDefinition = request.restoreDefinition;
      if (request.inspection.currentServer.kind === "present") {
        if (
          sourceCanonicals?.current ===
          canonicalDefinition(request.restoreDefinition)
        ) {
          return { kind: "unchanged" };
        }
        throw new InstallerError("CONFIG_CONFLICT");
      }
    }
  } else {
    if (
      request.inspection.currentServer.kind !== "present" ||
      state.server === undefined
    ) {
      invalid();
    }
    const desiredEnabled = request.action === "enable";
    const currentEnabled =
      options.toggleStrategy === "native-disabled"
        ? request.inspection.currentServer.definition.disabled === false
        : request.inspection.currentServer.definition.enabled === true;
    if (currentEnabled === desiredEnabled) {
      return { kind: "unchanged" };
    }
  }

  patchPass(request.counters);
  const { source } = state;
  let postText: string;
  if (insertedDefinition !== undefined) {
    const entry = definitionJson(insertedDefinition, options.dialect);
    if (source.missing) {
      postText = `${JSON.stringify(
        options.dialect === "opencode"
          ? {
              mcp: {
                servers: {
                  [state.serverName]: mappedConfigDefinition(
                    insertedDefinition,
                    options.dialect,
                  ),
                },
              },
            }
          : {
              [options.dialect === "vscode" ? "servers" : "mcpServers"]: {
                [state.serverName]: mappedConfigDefinition(
                  insertedDefinition,
                  options.dialect,
                ),
              },
            },
        undefined,
        2,
      )}\n`;
    } else if (state.root === undefined) invalid();
    else if (options.dialect === "opencode" && state.mcp === undefined) {
      postText = insertProperty(
        source.text,
        state.root,
        "mcp",
        `{"servers":{${JSON.stringify(state.serverName)}:${entry}}}`,
        source.newline,
        state.tokens,
      );
    } else if (state.servers === undefined) {
      postText = insertProperty(
        source.text,
        options.dialect === "opencode" ? (state.mcp as ObjectNode) : state.root,
        options.dialect === "opencode" || options.dialect === "vscode"
          ? "servers"
          : "mcpServers",
        `{${JSON.stringify(state.serverName)}:${entry}}`,
        source.newline,
        state.tokens,
      );
    } else {
      postText = insertProperty(
        source.text,
        state.servers,
        state.serverName,
        entry,
        source.newline,
        state.tokens,
      );
    }
  } else if (request.action === "remove") {
    if (state.servers === undefined || state.serverMember === undefined) {
      invalid();
    }
    postText = removeMember(
      source.text,
      state,
      state.servers,
      state.serverMember,
    );
  } else if (options.toggleStrategy === "detached") {
    if (
      state.servers === undefined ||
      state.serverMember === undefined ||
      request.action !== "disable"
    ) {
      invalid();
    }
    postText = removeMember(
      source.text,
      state,
      state.servers,
      state.serverMember,
    );
  } else {
    const desiredEnabled = request.action === "enable";
    const toggleField =
      options.toggleStrategy === "native-disabled" ? "disabled" : "enabled";
    const desiredValue =
      options.toggleStrategy === "native-disabled"
        ? !desiredEnabled
        : desiredEnabled;
    postText =
      state.toggle === undefined
        ? insertProperty(
            source.text,
            state.server as ObjectNode,
            toggleField,
            String(desiredValue),
            source.newline,
            state.tokens,
          )
        : replaceRange(source.text, state.toggle, String(desiredValue));
  }

  const postImage = encodeTargetPostImage(
    postText,
    source.bom,
    request.counters,
  );
  const postInspection = parseAndInspect(
    postImage,
    state.serverName,
    request.counters,
    "post-image",
    options,
    inspectionOwner,
  );
  assertPostImageDefinition(request, postInspection, options.toggleStrategy);
  return { kind: "changed", postImage };
}

export function createJsonTargetAdapter(
  options: JsonTargetOptions,
): TargetAdapter {
  const inspectionOwner = Object.freeze({});
  const parseOptions = Object.freeze({
    dialect: options.dialect,
    toggleStrategy: options.toggleStrategy,
  });
  return Object.freeze({
    metadata: Object.freeze({
      targetId: options.targetId,
      targetContractVersion: 1,
      format:
        options.dialect === "opencode" || options.dialect === "vscode"
          ? "jsonc"
          : "json",
      parentPath: Object.freeze(
        options.dialect === "opencode"
          ? ["mcp", "servers"]
          : options.dialect === "vscode"
            ? ["servers"]
            : ["mcpServers"],
      ),
      toggleStrategy: options.toggleStrategy,
    }),
    compatibility: options.compatibility,
    descriptorToDefinition: options.descriptorToDefinition,
    definitionToSuspendedDescriptor: options.definitionToSuspendedDescriptor,
    suspendedDescriptorToDefinition: (descriptor) => {
      const fake = {
        id: "suspended",
        version: "0.0.0",
        title: "Suspended",
        description: "Suspended",
        capabilityIds: ["suspended.entry"],
        server: descriptor,
      } satisfies CapabilityInstallDescriptor;
      if (!options.compatibility(fake).supported)
        return unsupportedDefinition();
      return options.descriptorToDefinition(fake);
    },
    inspect: ({ source, serverName, counters }) =>
      parseAndInspect(
        source,
        serverName,
        counters,
        "source",
        parseOptions,
        inspectionOwner,
      ),
    constructPatch: (request) =>
      constructPatch(request, parseOptions, inspectionOwner),
  } satisfies TargetAdapter);
}

export function jsonDefinition(
  definition: Record<string, unknown>,
  toggleStrategy: ToggleStrategy,
): Readonly<Record<string, unknown>> {
  return toggleStrategy === "native-enabled"
    ? freezeDefinition(definition)
    : freezeDetachedDefinition(definition);
}
