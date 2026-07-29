import {
  isAlias,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type Pair,
  type YAMLMap,
} from "yaml";

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
  targetInspectionStateFor,
  type DecodedTargetSource,
  type TargetAdapter,
  type TargetAdapterCounters,
  type TargetConfigInspection,
  type TargetPatch,
  type TargetPatchRequest,
  type InspectedJsonValue,
  unsupportedDefinition,
} from "./target-adapter.js";

interface YamlInspectionState {
  readonly source: DecodedTargetSource;
  readonly serverName: string;
  readonly root: YAMLMap | undefined;
  readonly parent: YAMLMap | undefined;
  readonly server: YAMLMap | undefined;
  readonly enabled: Node | null | undefined;
  readonly members: ReadonlyMap<YAMLMap, ReadonlyMap<string, Pair>>;
  readonly emptyInsertionOffset: number | undefined;
}

interface YamlAstInspection {
  readonly members: ReadonlyMap<YAMLMap, ReadonlyMap<string, Pair>>;
  readonly values: ReadonlyMap<Node, InspectedJsonValue>;
}

function invalid(cause?: unknown): never {
  throw new InstallerError("HARNESS_CONFIG_INVALID", cause);
}

function scalarKey(pair: Pair): string | undefined {
  return isScalar(pair.key) && typeof pair.key.value === "string"
    ? pair.key.value
    : undefined;
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

function inspectYamlAst(contents: Node, serverName: string): YamlAstInspection {
  const members = new Map<YAMLMap, ReadonlyMap<string, Pair>>();
  const values = new Map<Node, InspectedJsonValue>();
  const serverPath = ["mcp_servers", serverName] as const;
  type Task =
    | {
        readonly kind: "visit";
        readonly node: Node;
        readonly depth: number;
        readonly path: readonly string[];
        readonly assign: (assigned: InspectedJsonValue) => void;
      }
    | {
        readonly kind: "finish-map";
        readonly node: YAMLMap;
        readonly path: readonly string[];
        readonly fields: Map<string, InspectedJsonValue>;
        readonly assign: (assigned: InspectedJsonValue) => void;
      }
    | {
        readonly kind: "finish-sequence";
        readonly node: Node;
        readonly path: readonly string[];
        readonly items: InspectedJsonValue[];
        readonly assign: (assigned: InspectedJsonValue) => void;
      }
    | {
        readonly kind: "finish-pair";
        readonly fields: Map<string, InspectedJsonValue>;
        readonly assign: (assigned: InspectedJsonValue) => void;
      };
  const stack: Task[] = [
    {
      kind: "visit",
      node: contents,
      depth: 1,
      path: [],
      assign: () => undefined,
    },
  ];
  while (stack.length > 0) {
    const task = stack.pop() as Task;
    if (task.kind === "finish-map") {
      const inspected = inspectedJsonRecord(
        task.fields,
        selectedPath(task.path, serverPath),
        samePath(task.path, serverPath),
      );
      values.set(task.node, inspected);
      task.assign(inspected);
      continue;
    }
    if (task.kind === "finish-sequence") {
      const inspected = inspectedJsonArray(
        task.items,
        selectedPath(task.path, serverPath),
      );
      values.set(task.node, inspected);
      task.assign(inspected);
      continue;
    }
    if (task.kind === "finish-pair") {
      task.assign(inspectedJsonRecord(task.fields, false));
      continue;
    }
    const { node, depth, path, assign } = task;
    if (depth > 100 || isAlias(node) || ("anchor" in node && node.anchor)) {
      invalid();
    }
    if (isScalar(node)) {
      let scalar: unknown = node.value;
      if (typeof scalar === "bigint" && selectedPath(path, serverPath)) {
        if (
          scalar > BigInt(Number.MAX_SAFE_INTEGER) ||
          scalar < BigInt(Number.MIN_SAFE_INTEGER)
        ) {
          invalid();
        }
        scalar = Number(scalar);
      }
      const inspected = inspectedJsonScalar(
        scalar,
        selectedPath(path, serverPath),
      );
      values.set(node, inspected);
      assign(inspected);
      continue;
    }
    if (isMap(node)) {
      const restrictedTagPath =
        path.length === 0 ||
        samePath(path, ["mcp_servers"]) ||
        selectedPath(path, serverPath);
      if (
        node.tag !== undefined &&
        node.tag !== "tag:yaml.org,2002:map" &&
        restrictedTagPath
      ) {
        invalid();
      }
      const objectMembers = new Map<string, Pair>();
      const fields = new Map<string, InspectedJsonValue>();
      members.set(node, objectMembers);
      stack.push({ kind: "finish-map", node, path, fields, assign });
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        const pair = node.items[index] as Pair;
        const key = scalarKey(pair);
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          invalid();
        }
        if (
          pair.key.tag === "tag:yaml.org,2002:merge" ||
          (key === "<<" &&
            pair.key.type === "PLAIN" &&
            pair.key.tag === undefined)
        ) {
          invalid();
        }
        if (key === undefined || objectMembers.has(key)) invalid();
        objectMembers.set(key, pair);
        if (pair.key.anchor) invalid();
        const normalizedKey = samePath(path, [...serverPath, "headers"])
          ? key.toLowerCase()
          : key;
        if (pair.value === null) {
          const inspected = inspectedJsonScalar(
            null,
            selectedPath([...path, key], serverPath),
          );
          if (fields.has(normalizedKey)) invalid();
          fields.set(normalizedKey, inspected);
          continue;
        }
        if (!isNode(pair.value)) invalid();
        stack.push({
          kind: "visit",
          node: pair.value,
          depth: isMap(pair.value) || isSeq(pair.value) ? depth + 1 : depth,
          path: [...path, key],
          assign: (assigned) => {
            if (fields.has(normalizedKey)) invalid();
            fields.set(normalizedKey, assigned);
          },
        });
      }
    } else if (isSeq(node)) {
      const restrictedTagPath =
        path.length === 0 ||
        samePath(path, ["mcp_servers"]) ||
        selectedPath(path, serverPath);
      if (
        node.tag !== undefined &&
        node.tag !== "tag:yaml.org,2002:seq" &&
        restrictedTagPath
      ) {
        invalid();
      }
      const items = new Array<InspectedJsonValue>(node.items.length);
      stack.push({ kind: "finish-sequence", node, path, items, assign });
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        const item = node.items[index];
        if (isNode(item)) {
          stack.push({
            kind: "visit",
            node: item,
            depth: isMap(item) || isSeq(item) ? depth + 1 : depth,
            path,
            assign: (assigned) => {
              items[index] = assigned;
            },
          });
        } else if (isPair(item)) {
          const pairDepth = depth + 1;
          if (pairDepth > 100) invalid();
          if (!isScalar(item.key) || typeof item.key.value !== "string") {
            invalid();
          }
          const key = item.key.value;
          if (
            item.key.tag === "tag:yaml.org,2002:merge" ||
            (key === "<<" &&
              item.key.type === "PLAIN" &&
              item.key.tag === undefined) ||
            item.key.anchor
          ) {
            invalid();
          }
          const fields = new Map<string, InspectedJsonValue>();
          stack.push({
            kind: "finish-pair",
            fields,
            assign: (assigned) => {
              items[index] = assigned;
            },
          });
          if (item.value === null) {
            fields.set(key, inspectedJsonScalar(null, false));
          } else {
            if (!isNode(item.value)) invalid();
            stack.push({
              kind: "visit",
              node: item.value,
              depth:
                isMap(item.value) || isSeq(item.value)
                  ? pairDepth + 1
                  : pairDepth,
              path: [...path, key],
              assign: (assigned) => {
                fields.set(key, assigned);
              },
            });
          }
        } else if (item === null) {
          items[index] = inspectedJsonScalar(
            null,
            selectedPath(path, serverPath),
          );
        } else invalid();
      }
    } else invalid();
  }
  return { members, values };
}

function mapValue(
  members: ReadonlyMap<YAMLMap, ReadonlyMap<string, Pair>>,
  map: YAMLMap,
  key: string,
): YAMLMap | undefined {
  const pair = members.get(map)?.get(key);
  if (pair === undefined) return undefined;
  if (!isMap(pair.value)) invalid();
  return pair.value;
}

function parseAndInspect(
  sourceBytes: Uint8Array | undefined,
  serverName: string,
  counters: TargetAdapterCounters | undefined,
  phase: "source" | "post-image",
  inspectionOwner: object,
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
        parent: undefined,
        server: undefined,
        enabled: undefined,
        members: new Map(),
        emptyInsertionOffset: undefined,
      } satisfies YamlInspectionState,
      undefined,
      inspectionOwner,
    );
  }
  parsePass(counters, phase);
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source.text, {
      intAsBigInt: true,
      keepSourceTokens: true,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
      version: "1.2",
    });
  } catch (cause) {
    return invalid(cause);
  }
  if (document.errors.length > 0 || document.warnings.length > 0) invalid();
  const emptyContents =
    document.contents === null ||
    (isScalar(document.contents) &&
      document.contents.value === null &&
      document.contents.range?.[0] === document.contents.range?.[1]);
  if (emptyContents) {
    const documentValueEnd =
      document.contents?.range?.[1] ?? document.range?.[1] ?? 0;
    const followingNewline = source.text.indexOf("\n", documentValueEnd);
    const emptyInsertionOffset = source.text.startsWith("...", documentValueEnd)
      ? documentValueEnd
      : followingNewline < 0
        ? source.text.length
        : followingNewline + 1;
    if (phase === "source") inspectionPass(counters);
    return frozenTargetInspection(
      { kind: "absent" },
      {
        source,
        serverName,
        root: undefined,
        parent: undefined,
        server: undefined,
        enabled: undefined,
        members: new Map(),
        emptyInsertionOffset,
      } satisfies YamlInspectionState,
      undefined,
      inspectionOwner,
    );
  }
  if (!isMap(document.contents)) invalid();
  const astInspection = inspectYamlAst(document.contents, serverName);
  const root = document.contents;
  const parent = mapValue(astInspection.members, root, "mcp_servers");
  const server =
    parent === undefined
      ? undefined
      : mapValue(astInspection.members, parent, serverName);
  const inspectedServer =
    server === undefined ? undefined : astInspection.values.get(server);
  if (server !== undefined && inspectedServer?.kind !== "record") invalid();
  const finalized =
    inspectedServer?.kind === "record"
      ? finalizeInspectedMcpDefinition(inspectedServer, {
          stdioEnvironmentField: "env",
          stdioEnvironmentKind: "object",
          httpHeadersField: "headers",
          rawTransportPolicy: "reject",
        })
      : undefined;
  const enabledCandidate =
    server === undefined
      ? undefined
      : astInspection.members.get(server)?.get("enabled")?.value;
  if (
    enabledCandidate !== undefined &&
    enabledCandidate !== null &&
    !isNode(enabledCandidate)
  ) {
    invalid();
  }
  const enabled = enabledCandidate as Node | null | undefined;
  if (phase === "source") inspectionPass(counters);
  return frozenTargetInspection(
    finalized === undefined
      ? { kind: "absent" }
      : { kind: "present", definition: finalized.definition },
    {
      source,
      serverName,
      root,
      parent,
      server,
      enabled,
      members: astInspection.members,
      emptyInsertionOffset: undefined,
    } satisfies YamlInspectionState,
    finalized?.canonicals,
    inspectionOwner,
  );
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderDefinitionLines(
  definition: Readonly<Record<string, unknown>>,
  indent: string,
): readonly string[] {
  const lines: string[] = [];
  if (
    typeof definition.command === "string" &&
    Array.isArray(definition.args)
  ) {
    lines.push(`${indent}command: ${yamlString(definition.command)}`);
    lines.push(
      `${indent}args: [${definition.args
        .map((argument) => yamlString(argument as string))
        .join(", ")}]`,
    );
    if (
      typeof definition.env === "object" &&
      definition.env !== null &&
      !Array.isArray(definition.env) &&
      Object.keys(definition.env).length > 0
    ) {
      lines.push(`${indent}env:`);
      for (const [name, value] of Object.entries(definition.env)) {
        lines.push(`${indent}  ${name}: ${yamlString(value as string)}`);
      }
    }
  } else if (typeof definition.url === "string") {
    lines.push(`${indent}url: ${yamlString(definition.url)}`);
    if (
      typeof definition.headers === "object" &&
      definition.headers !== null &&
      !Array.isArray(definition.headers) &&
      Object.keys(definition.headers).length > 0
    ) {
      lines.push(`${indent}headers:`);
      for (const [name, value] of Object.entries(definition.headers)) {
        const renderedName = name === "authorization" ? "Authorization" : name;
        lines.push(
          `${indent}  ${yamlString(renderedName)}: ${yamlString(value as string)}`,
        );
      }
    }
  } else invalid();
  lines.push(`${indent}enabled: ${String(definition.enabled)}`);
  return lines;
}

function renderServerBlock(
  serverName: string,
  definition: Readonly<Record<string, unknown>>,
  keyIndent: string,
  newline: string,
): string {
  return [
    `${keyIndent}${serverName}:`,
    ...renderDefinitionLines(definition, `${keyIndent}  `),
  ].join(newline);
}

function yamlConfigDefinition(
  definition: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { transport: _transport, ...configDefinition } = definition;
  if (
    typeof configDefinition.headers !== "object" ||
    configDefinition.headers === null ||
    Array.isArray(configDefinition.headers)
  ) {
    if (
      typeof configDefinition.env === "object" &&
      configDefinition.env !== null &&
      !Array.isArray(configDefinition.env) &&
      Object.keys(configDefinition.env).length === 0
    ) {
      const { env: _env, ...withoutEmptyEnv } = configDefinition;
      return withoutEmptyEnv;
    }
    return configDefinition;
  }
  const withHeaders = {
    ...configDefinition,
    headers: Object.fromEntries(
      Object.entries(configDefinition.headers).map(([name, value]) => [
        name === "authorization" ? "Authorization" : name,
        value,
      ]),
    ),
  };
  if (Object.keys(withHeaders.headers).length === 0) {
    const { headers: _headers, ...withoutEmptyHeaders } = withHeaders;
    return withoutEmptyHeaders;
  }
  return withHeaders;
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  return /^[\t ]*/u.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

function insertFlowProperty(
  text: string,
  map: YAMLMap,
  key: string,
  value: string,
): string {
  const range = map.range;
  if (range === undefined || range === null) invalid();
  const close = range[1] - 1;
  if (text[close] !== "}") invalid();
  const last = map.items.at(-1) as Pair | undefined;
  if (last === undefined) {
    return `${text.slice(0, close)}${JSON.stringify(key)}: ${value}${text.slice(close)}`;
  }
  const lastRange = isNode(last.value) ? last.value.range : undefined;
  if (lastRange === undefined || lastRange === null) invalid();
  const sourceToken = map.srcToken;
  const trailingItem =
    sourceToken?.type === "flow-collection"
      ? sourceToken.items[map.items.length]
      : undefined;
  const hasTrailingComma =
    trailingItem?.start.some((token) => token.type === "comma") ?? false;
  const separator = hasTrailingComma ? " " : ", ";
  return `${text.slice(0, close)}${separator}${JSON.stringify(key)}: ${value}${text.slice(close)}`;
}

function insertBlockEntry(
  source: DecodedTargetSource,
  map: YAMLMap,
  block: string,
): string {
  const range = map.range;
  if (range === undefined || range === null) invalid();
  const insertion = range[2];
  const prefix = source.text.slice(0, insertion);
  const suffix = source.text.slice(insertion);
  return `${prefix}${prefix.endsWith("\n") ? "" : source.newline}${block}${suffix.length > 0 || source.trailingNewline ? source.newline : ""}${suffix}`;
}

function appendRootBlock(source: DecodedTargetSource, block: string): string {
  if (source.missing || source.text.length === 0) return `${block}\n`;
  const withoutTrailing = source.text.replace(/(?:\r?\n)+$/u, "");
  const result = `${withoutTrailing}${source.newline}${block}`;
  return source.trailingNewline ? `${result}${source.newline}` : result;
}

function insertEmptyDocumentBlock(
  source: DecodedTargetSource,
  offset: number,
  block: string,
): string {
  const prefix = source.text.slice(0, offset);
  const suffix = source.text.slice(offset);
  return `${prefix}${prefix.length > 0 && !prefix.endsWith("\n") ? source.newline : ""}${block}${suffix.length > 0 || source.trailingNewline ? source.newline : ""}${suffix}`;
}

function constructPatch(
  request: TargetPatchRequest,
  inspectionOwner: object,
): TargetPatch {
  assertTargetInspectionConsistency(request.inspection);
  const state = targetInspectionStateFor<YamlInspectionState>(
    request.inspection,
    inspectionOwner,
  );
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
  let postText: string;
  if (request.action === "install") {
    const block = [
      "mcp_servers:",
      renderServerBlock(
        state.serverName,
        request.definition,
        "  ",
        state.source.newline,
      ),
    ].join(state.source.newline);
    if (state.source.missing) {
      postText = appendRootBlock(state.source, block);
    } else if (state.root === undefined) {
      postText = insertEmptyDocumentBlock(
        state.source,
        state.emptyInsertionOffset ?? state.source.text.length,
        block,
      );
    } else if (state.parent === undefined && state.root.flow) {
      postText = insertFlowProperty(
        state.source.text,
        state.root,
        "mcp_servers",
        JSON.stringify({
          [state.serverName]: yamlConfigDefinition(request.definition),
        }),
      );
    } else if (state.parent === undefined) {
      postText = insertBlockEntry(state.source, state.root, block);
    } else if (state.parent.flow) {
      postText = insertFlowProperty(
        state.source.text,
        state.parent,
        state.serverName,
        JSON.stringify(yamlConfigDefinition(request.definition)),
      );
    } else {
      const firstPair = state.parent.items[0] as Pair | undefined;
      const keyRange =
        firstPair !== undefined && isNode(firstPair.key)
          ? firstPair.key.range
          : undefined;
      const keyIndent =
        keyRange === undefined || keyRange === null
          ? "  "
          : lineIndent(state.source.text, keyRange[0]);
      postText = insertBlockEntry(
        state.source,
        state.parent,
        renderServerBlock(
          state.serverName,
          request.definition,
          keyIndent,
          state.source.newline,
        ),
      );
    }
  } else {
    const desired = request.action === "enable";
    if (state.enabled !== undefined && state.enabled !== null) {
      const range = state.enabled.range;
      if (range === undefined || range === null) invalid();
      postText = `${state.source.text.slice(0, range[0])}${String(desired)}${state.source.text.slice(range[1])}`;
    } else if ((state.server as YAMLMap).flow) {
      postText = insertFlowProperty(
        state.source.text,
        state.server as YAMLMap,
        "enabled",
        String(desired),
      );
    } else {
      const firstPair = (state.server as YAMLMap).items[0] as Pair | undefined;
      const keyRange =
        firstPair !== undefined && isNode(firstPair.key)
          ? firstPair.key.range
          : undefined;
      const indent =
        keyRange === undefined || keyRange === null
          ? "    "
          : lineIndent(state.source.text, keyRange[0]);
      postText = insertBlockEntry(
        state.source,
        state.server as YAMLMap,
        `${indent}enabled: ${String(desired)}`,
      );
    }
  }
  const postImage = encodeTargetPostImage(
    postText,
    state.source.bom,
    request.counters,
  );
  const postInspection = parseAndInspect(
    postImage,
    state.serverName,
    request.counters,
    "post-image",
    inspectionOwner,
  );
  assertPostImageDefinition(request, postInspection);
  return { kind: "changed", postImage };
}

export function createYamlTargetAdapter(options: {
  readonly compatibility: TargetAdapter["compatibility"];
  readonly descriptorToDefinition: TargetAdapter["descriptorToDefinition"];
  readonly definitionToSuspendedDescriptor: TargetAdapter["definitionToSuspendedDescriptor"];
}): TargetAdapter {
  const inspectionOwner = Object.freeze({});
  return Object.freeze({
    metadata: Object.freeze({
      targetId: "hermes",
      targetContractVersion: 1,
      format: "yaml",
      parentPath: Object.freeze(["mcp_servers"]),
      toggleStrategy: "native-enabled",
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
      parseAndInspect(source, serverName, counters, "source", inspectionOwner),
    constructPatch: (request) => constructPatch(request, inspectionOwner),
  } satisfies TargetAdapter);
}

export function yamlDefinition(
  definition: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  return freezeDefinition(definition);
}
