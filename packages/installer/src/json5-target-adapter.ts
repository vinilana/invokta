import {
  parse,
  type ArrayNode,
  type DocumentNode,
  type MemberNode,
  type ObjectNode,
  type Token,
  type ValueNode,
} from "@humanwhocodes/momoa";

import { InstallerError } from "./installer-error.js";
import type { CapabilityInstallDescriptor } from "./registry.js";
import {
  assertPostImageDefinition,
  assertServerName,
  assertTargetInspectionConsistency,
  decodeTargetSource,
  encodeTargetPostImage,
  finalizeInspectedMcpDefinition,
  freezeDefinition,
  frozenTargetInspection,
  inspectedJsonArray,
  inspectedJsonRecord,
  inspectedJsonScalar,
  inspectionPass,
  parsePass,
  patchPass,
  targetInspectionState,
  type DecodedTargetSource,
  type TargetAdapter,
  type TargetAdapterCounters,
  type TargetConfigInspection,
  type TargetPatch,
  type TargetPatchRequest,
  type InspectedJsonValue,
  unsupportedDefinition,
} from "./target-adapter.js";

interface Json5InspectionState {
  readonly source: DecodedTargetSource;
  readonly serverName: string;
  readonly root: ObjectNode | undefined;
  readonly mcp: ObjectNode | undefined;
  readonly servers: ObjectNode | undefined;
  readonly server: ObjectNode | undefined;
  readonly enabled: ValueNode | undefined;
  readonly members: ReadonlyMap<ObjectNode, ReadonlyMap<string, MemberNode>>;
  readonly tokens: readonly Token[];
}

interface AstInspection {
  readonly members: ReadonlyMap<ObjectNode, ReadonlyMap<string, MemberNode>>;
  readonly values: ReadonlyMap<ValueNode, InspectedJsonValue>;
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

function memberName(member: MemberNode): string {
  return member.name.type === "Identifier"
    ? member.name.name
    : member.name.value;
}

function scalarValue(node: ValueNode): unknown {
  switch (node.type) {
    case "Null":
      return null;
    case "Boolean":
    case "String":
    case "Number":
      return node.value;
    case "NaN":
      return Number.NaN;
    case "Infinity":
      return node.sign === "-"
        ? Number.NEGATIVE_INFINITY
        : Number.POSITIVE_INFINITY;
    default:
      return invalid();
  }
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

function inspectAst(document: DocumentNode, serverName: string): AstInspection {
  const members = new Map<ObjectNode, ReadonlyMap<string, MemberNode>>();
  const values = new Map<ValueNode, InspectedJsonValue>();
  const serverPath = ["mcp", "servers", serverName] as const;
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
        selectedPath(task.path, serverPath),
      );
      values.set(task.node, inspected);
      task.assign(inspected);
      continue;
    }
    if (task.kind === "finish-object") {
      const inspected = inspectedJsonRecord(
        task.fields,
        selectedPath(task.path, serverPath),
        samePath(task.path, serverPath),
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
        if (name === "$include") {
          throw new InstallerError("HARNESS_CONFIG_AMBIGUOUS");
        }
        objectMembers.set(name, member);
        const child = member.value;
        const normalizedName = samePath(path, [...serverPath, "headers"])
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
        const child = (node as ArrayNode).elements[index]?.value;
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
      selectedPath(path, serverPath),
    );
    values.set(node, inspected);
    assign(inspected);
  }
  return { members, values };
}

function objectMember(
  state: Pick<Json5InspectionState, "members">,
  object: ObjectNode | undefined,
  key: string,
): MemberNode | undefined {
  return object === undefined ? undefined : state.members.get(object)?.get(key);
}

function objectValue(
  state: Pick<Json5InspectionState, "members">,
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

function parseAndInspect(
  sourceBytes: Uint8Array | undefined,
  serverName: string,
  counters: TargetAdapterCounters | undefined,
  phase: "source" | "post-image",
): TargetConfigInspection {
  assertServerName(serverName);
  const source = decodeTargetSource(sourceBytes, counters, phase);
  if (source.missing) {
    if (phase === "source") inspectionPass(counters);
    return frozenTargetInspection(
      { kind: "absent" },
      {
        source,
        serverName,
        root: undefined,
        mcp: undefined,
        servers: undefined,
        server: undefined,
        enabled: undefined,
        members: new Map(),
        tokens: [],
      } satisfies Json5InspectionState,
      undefined,
    );
  }
  parsePass(counters, phase);
  let document: DocumentNode;
  let astInspection: AstInspection;
  try {
    document = parse(source.text, {
      mode: "json5",
      ranges: true,
      tokens: true,
    });
    astInspection = inspectAst(document, serverName);
  } catch (cause) {
    if (cause instanceof InstallerError) throw cause;
    return invalid(cause);
  }
  if (document.body.type !== "Object") invalid();
  const root = document.body;
  const state = {
    members: astInspection.members,
  };
  const mcp = objectNode(objectValue(state, root, "mcp"));
  const servers = objectNode(objectValue(state, mcp, "servers"));
  const server = objectNode(objectValue(state, servers, serverName));

  const inspectedServer =
    server === undefined ? undefined : astInspection.values.get(server);
  if (server !== undefined && inspectedServer?.kind !== "record") invalid();
  const finalized =
    inspectedServer?.kind === "record"
      ? finalizeInspectedMcpDefinition(inspectedServer, {
          stdioEnvironmentField: "env",
          stdioEnvironmentKind: "object",
          httpHeadersField: "headers",
          rawTransportPolicy: "allow-openclaw-http",
        })
      : undefined;
  const enabled = objectValue(state, server, "enabled");
  if (phase === "source") inspectionPass(counters);
  return frozenTargetInspection(
    finalized === undefined
      ? { kind: "absent" }
      : { kind: "present", definition: finalized.definition },
    {
      source,
      serverName,
      root,
      mcp,
      servers,
      server,
      enabled,
      members: astInspection.members,
      tokens: document.tokens ?? [],
    } satisfies Json5InspectionState,
    finalized?.canonicals,
  );
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  return /^[\t ]*/u.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

function hasTrailingComma(
  state: Json5InspectionState,
  object: ObjectNode,
): boolean {
  const last = object.members.at(-1);
  if (last === undefined) return false;
  const [, lastEnd] = range(last);
  const [, objectEnd] = range(object);
  return state.tokens.some(
    (token) =>
      token.type === "Comma" &&
      range(token)[0] >= lastEnd &&
      range(token)[1] < objectEnd,
  );
}

function insertProperty(
  text: string,
  state: Json5InspectionState,
  object: ObjectNode,
  key: string,
  value: string,
  newline: string,
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
  let withComma = text;
  let adjustedClose = close;
  if (!hasTrailingComma(state, object)) {
    withComma = `${text.slice(0, lastEnd)},${text.slice(lastEnd)}`;
    adjustedClose += 1;
  }
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

function jsonConfigDefinition(
  definition: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const isStdio = definition.transport === "stdio";
  const configDefinition = isStdio
    ? Object.fromEntries(
        Object.entries(definition).filter(([key]) => key !== "transport"),
      )
    : { ...definition };
  if (
    typeof configDefinition.env === "object" &&
    configDefinition.env !== null &&
    !Array.isArray(configDefinition.env) &&
    Object.keys(configDefinition.env).length === 0
  ) {
    delete configDefinition.env;
  }
  if (
    typeof configDefinition.headers !== "object" ||
    configDefinition.headers === null ||
    Array.isArray(configDefinition.headers)
  ) {
    return configDefinition;
  }
  if (Object.keys(configDefinition.headers).length === 0) {
    delete configDefinition.headers;
    return configDefinition;
  }
  configDefinition.headers = Object.fromEntries(
    Object.entries(configDefinition.headers).map(([name, value]) => [
      name === "authorization" ? "Authorization" : name,
      value,
    ]),
  );
  return configDefinition;
}

function jsonDefinition(definition: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(jsonConfigDefinition(definition));
}

function constructPatch(request: TargetPatchRequest): TargetPatch {
  assertTargetInspectionConsistency(request.inspection);
  const rawState = request.inspection[targetInspectionState];
  if (
    typeof rawState !== "object" ||
    rawState === null ||
    !("source" in rawState) ||
    !("serverName" in rawState)
  ) {
    invalid();
  }
  const state = rawState as Json5InspectionState;
  if (request.action === "install") {
    if (request.inspection.currentServer.kind === "present") {
      throw new InstallerError("CONFIG_CONFLICT");
    }
  } else {
    if (
      request.inspection.currentServer.kind !== "present" ||
      state.server === undefined
    ) {
      invalid();
    }
    const desired = request.action === "enable";
    if (request.inspection.currentServer.definition.enabled === desired) {
      return { kind: "unchanged" };
    }
  }

  patchPass(request.counters);
  const { source } = state;
  let postText: string;
  if (request.action === "install") {
    const entry = jsonDefinition(request.definition);
    if (source.missing) {
      postText = `${JSON.stringify(
        {
          mcp: {
            servers: {
              [state.serverName]: jsonConfigDefinition(request.definition),
            },
          },
        },
        undefined,
        2,
      )}\n`;
    } else if (state.root === undefined) invalid();
    else if (state.mcp === undefined) {
      postText = insertProperty(
        source.text,
        state,
        state.root,
        "mcp",
        `{"servers":{${JSON.stringify(state.serverName)}:${entry}}}`,
        source.newline,
      );
    } else if (state.servers === undefined) {
      postText = insertProperty(
        source.text,
        state,
        state.mcp,
        "servers",
        `{${JSON.stringify(state.serverName)}:${entry}}`,
        source.newline,
      );
    } else {
      postText = insertProperty(
        source.text,
        state,
        state.servers,
        state.serverName,
        entry,
        source.newline,
      );
    }
  } else {
    const desired = request.action === "enable";
    postText =
      state.enabled === undefined
        ? insertProperty(
            source.text,
            state,
            state.server as ObjectNode,
            "enabled",
            String(desired),
            source.newline,
          )
        : replaceRange(source.text, state.enabled, String(desired));
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
  );
  assertPostImageDefinition(request, postInspection);
  return { kind: "changed", postImage };
}

export function createJson5TargetAdapter(options: {
  readonly compatibility: TargetAdapter["compatibility"];
  readonly descriptorToDefinition: TargetAdapter["descriptorToDefinition"];
}): TargetAdapter {
  return Object.freeze({
    metadata: Object.freeze({
      targetId: "openclaw",
      targetContractVersion: 1,
      format: "json5",
      parentPath: Object.freeze(["mcp", "servers"]),
      toggleStrategy: "native-enabled",
    }),
    compatibility: options.compatibility,
    descriptorToDefinition: options.descriptorToDefinition,
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
      parseAndInspect(source, serverName, counters, "source"),
    constructPatch,
  } satisfies TargetAdapter);
}

export function json5Definition(
  definition: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  return freezeDefinition(definition);
}
