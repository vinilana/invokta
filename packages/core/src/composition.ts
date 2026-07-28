import { types as nodeUtilTypes } from "node:util";

import {
  CapabilityCompositionError,
  type CapabilityCompositionIssue,
  type CapabilityDeclarationProvenance,
} from "./composition-error.js";
import type {
  ComposedEntries,
  CompositionDiagnostics,
  RemapDiagnostics,
  RemappedEntries,
  SelectedEntries,
} from "./composition-types.js";
import type { AnyCapability, CapabilityMap } from "./types.js";

const exportedCapabilityBrand: unique symbol = Symbol.for(
  "@ai-engine/core.exportedCapability",
);
const capabilityLibraryBrand: unique symbol = Symbol.for(
  "@ai-engine/core.capabilityLibrary",
);
const capabilityImportBrand: unique symbol = Symbol.for(
  "@ai-engine/core.capabilityImport",
);
const composedCapabilitiesBrand: unique symbol = Symbol.for(
  "@ai-engine/core.composedCapabilities",
);

declare const capabilityImportEntries: unique symbol;

export interface CapabilitySource {
  readonly name: string;
  readonly version?: string;
}

export interface ExportedCapability<
  DefaultId extends string = string,
  Capability extends AnyCapability = AnyCapability,
> {
  readonly [exportedCapabilityBrand]: true;
  readonly source: CapabilitySource;
  readonly defaultId: DefaultId;
  readonly capability: Capability;
}

export interface CapabilityLibrary<
  Capabilities extends CapabilityMap = CapabilityMap,
> {
  readonly [capabilityLibraryBrand]: true;
  readonly name: string;
  readonly version: string;
  readonly capabilities: Capabilities;
}

export interface CapabilityImport<
  Entries extends CapabilityMap = CapabilityMap,
> {
  readonly [capabilityImportBrand]: true;
  readonly [capabilityImportEntries]: Entries;
}

export type AnyCapabilityImport = CapabilityImport<CapabilityMap>;

export type ComposedCapabilities<
  Capabilities extends CapabilityMap = CapabilityMap,
> = Capabilities & { readonly [composedCapabilitiesBrand]: true };

type AtomicImportRecord = {
  readonly kind: "atomic";
  readonly valid: false;
};

type ResolvedAtomicImportRecord = {
  readonly kind: "atomic";
  readonly valid: true;
  readonly effectiveId: string;
  readonly capability: AnyCapability;
  readonly provenance: CapabilityDeclarationProvenance;
};

type LibraryImportRecord = {
  readonly kind: "library";
  readonly libraryName: string;
  readonly libraryVersion: string;
  readonly defaultIds: readonly string[];
  readonly capabilities: Readonly<Record<string, AnyCapability>>;
  readonly include?: readonly string[];
  readonly remap?: Readonly<Record<string, string>>;
};

type ImportRecord =
  | AtomicImportRecord
  | ResolvedAtomicImportRecord
  | LibraryImportRecord;

function rejectProxy(value: object, description: string): void {
  if (nodeUtilTypes.isProxy(value)) {
    throw new TypeError(`${description} must not be a proxy.`);
  }
}

/**
 * Composition inputs are user-supplied objects, so every property is read once
 * into a local: a getter re-invoked later could report a different ID than the
 * one that was validated.
 */
function readOnce(target: object, key: string): unknown {
  let current: object | null = target;
  while (current !== null) {
    rejectProxy(current, "A composition descriptor");
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if ("value" in descriptor) return descriptor.value;
      const getter = descriptor.get;
      return getter === undefined
        ? undefined
        : Reflect.apply(getter, target, []);
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function readRecord(value: unknown, description: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object.`);
  }
  rejectProxy(value, description);
  return value;
}

function readNonEmptyString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${description} must be a non-empty string.`);
  }
  return value;
}

function hasBrand(value: unknown, brand: symbol): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (nodeUtilTypes.isProxy(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, brand);
  return descriptor !== undefined && descriptor.value === true;
}

function brand<Value extends object>(value: Value, key: symbol): Value {
  Object.defineProperty(value, key, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return value;
}

function snapshotCapabilityMap(
  value: unknown,
  description: string,
): {
  readonly ids: readonly string[];
  readonly capabilities: Readonly<Record<string, AnyCapability>>;
} {
  const source = readRecord(value, description);
  const ids: string[] = [];
  const capabilities: Record<string, AnyCapability> = {};
  for (const id of Object.keys(source)) {
    const capability = readOnce(source, id);
    if (capability === undefined) continue;
    ids.push(id);
    capabilities[id] = capability as AnyCapability;
  }
  return {
    ids: Object.freeze(ids),
    capabilities: Object.freeze(capabilities),
  };
}

export function defineExportedCapability<
  const DefaultId extends string,
  const Capability extends AnyCapability,
>(definition: {
  readonly source: CapabilitySource;
  readonly defaultId: DefaultId;
  readonly capability: Capability;
}): ExportedCapability<DefaultId, Capability> {
  const target = readRecord(definition, "An exported capability definition");
  const source = readRecord(
    readOnce(target, "source"),
    "Exported capability source metadata",
  );
  const name = readNonEmptyString(
    readOnce(source, "name"),
    "An exported capability source name",
  );
  const version: unknown = readOnce(source, "version");
  if (version !== undefined) {
    readNonEmptyString(version, "An exported capability source version");
  }
  const defaultId = readNonEmptyString(
    readOnce(target, "defaultId"),
    "An exported capability default ID",
  );
  const capability = readOnce(target, "capability");
  if (typeof capability !== "object" || capability === null) {
    throw new TypeError("An exported capability must be an object.");
  }

  const descriptor = {
    source: Object.freeze(
      version === undefined ? { name } : { name, version: version as string },
    ),
    defaultId,
    capability,
  };
  return Object.freeze(
    brand(descriptor, exportedCapabilityBrand),
  ) as unknown as ExportedCapability<DefaultId, Capability>;
}

export function defineCapabilityLibrary<
  const Capabilities extends CapabilityMap,
>(definition: {
  readonly name: string;
  readonly version: string;
  readonly capabilities: Capabilities;
}): CapabilityLibrary<Capabilities> {
  const target = readRecord(definition, "A capability library definition");
  const name = readNonEmptyString(
    readOnce(target, "name"),
    "A capability library name",
  );
  const version = readNonEmptyString(
    readOnce(target, "version"),
    "A capability library version",
  );
  const snapshot = snapshotCapabilityMap(
    readOnce(target, "capabilities"),
    "A capability library capability map",
  );

  const descriptor = {
    name,
    version,
    capabilities: snapshot.capabilities,
    defaultIds: snapshot.ids,
  };
  return Object.freeze(
    brand(descriptor, capabilityLibraryBrand),
  ) as unknown as CapabilityLibrary<Capabilities>;
}

function createImportRecord(record: ImportRecord): AnyCapabilityImport {
  return Object.freeze(
    brand(record, capabilityImportBrand),
  ) as unknown as AnyCapabilityImport;
}

export function importCapability<
  const DefaultId extends string,
  const Capability extends AnyCapability,
>(
  exported: ExportedCapability<DefaultId, Capability>,
): CapabilityImport<{ readonly [Key in DefaultId]: Capability }>;
export function importCapability<
  const DefaultId extends string,
  const Capability extends AnyCapability,
  const As extends string,
>(
  exported: ExportedCapability<DefaultId, Capability>,
  options: { readonly as: As },
): CapabilityImport<{ readonly [Key in As]: Capability }>;
export function importCapability(
  exported: ExportedCapability,
  options?: { readonly as: string },
): AnyCapabilityImport {
  let effectiveId: string | undefined;
  if (options !== undefined) {
    const target = readRecord(options, "Atomic import options");
    effectiveId = readNonEmptyString(
      readOnce(target, "as"),
      "An atomic import effective ID",
    );
  }

  if (!hasBrand(exported, exportedCapabilityBrand)) {
    return createImportRecord({
      kind: "atomic",
      valid: false,
    });
  }

  const descriptor = exported as unknown as object;
  const source = readRecord(
    readOnce(descriptor, "source"),
    "Exported capability source metadata",
  );
  const sourceName = readNonEmptyString(
    readOnce(source, "name"),
    "An exported capability source name",
  );
  const sourceVersion: unknown = readOnce(source, "version");
  const defaultId = readNonEmptyString(
    readOnce(descriptor, "defaultId"),
    "An exported capability default ID",
  );
  const capability = readOnce(descriptor, "capability") as AnyCapability;

  return createImportRecord({
    kind: "atomic",
    valid: true,
    effectiveId: effectiveId ?? defaultId,
    capability,
    provenance: Object.freeze({
      kind: "atomic",
      sourceName,
      ...(sourceVersion === undefined
        ? {}
        : {
            sourceVersion: readNonEmptyString(
              sourceVersion,
              "An exported capability source version",
            ),
          }),
      defaultId,
    }),
  });
}

function readIncludeList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError("A library import include list must be an array.");
  }
  rejectProxy(value, "A library import include list");
  const include: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    include.push(
      readNonEmptyString(value[index], "A library import include entry"),
    );
  }
  return Object.freeze(include);
}

function readRemapTable(value: unknown): Readonly<Record<string, string>> {
  const source = readRecord(value, "A library import remap table");
  const remap: Record<string, string> = {};
  for (const defaultId of Object.keys(source)) {
    const target = readOnce(source, defaultId);
    if (target === undefined) continue;
    remap[defaultId] = readNonEmptyString(
      target,
      "A library import remap target",
    );
  }
  return Object.freeze(remap);
}

export function importCapabilities<const Capabilities extends CapabilityMap>(
  library: CapabilityLibrary<Capabilities>,
): CapabilityImport<Capabilities>;
export function importCapabilities<
  const Capabilities extends CapabilityMap,
  const Remap extends {
    readonly [Key in keyof Remap]: Key extends Extract<
      keyof Capabilities,
      string
    >
      ? string
      : never;
  },
>(
  library: CapabilityLibrary<Capabilities>,
  options: { readonly remap: Remap } & RemapDiagnostics<Remap>,
): CapabilityImport<RemappedEntries<Capabilities, Remap>>;
export function importCapabilities<
  const Capabilities extends CapabilityMap,
  const Include extends ReadonlyArray<Extract<keyof Capabilities, string>>,
  const Remap extends {
    readonly [Key in keyof Remap]: Key extends Include[number] ? string : never;
  } = Record<never, never>,
>(
  library: CapabilityLibrary<Capabilities>,
  options: {
    readonly include: Include;
    readonly remap?: Remap;
  } & RemapDiagnostics<Remap>,
): CapabilityImport<
  RemappedEntries<SelectedEntries<Capabilities, Include>, Remap>
>;
export function importCapabilities(
  library: CapabilityLibrary,
  options?: {
    readonly include?: readonly string[];
    readonly remap?: Readonly<Record<string, string>>;
  },
): AnyCapabilityImport {
  if (!hasBrand(library, capabilityLibraryBrand)) {
    throw new TypeError(
      "A library import requires a defineCapabilityLibrary descriptor.",
    );
  }
  const descriptor = library as unknown as object;
  const libraryName = readNonEmptyString(
    readOnce(descriptor, "name"),
    "A capability library name",
  );
  const libraryVersion = readNonEmptyString(
    readOnce(descriptor, "version"),
    "A capability library version",
  );
  const snapshot = snapshotCapabilityMap(
    readOnce(descriptor, "capabilities"),
    "A capability library capability map",
  );

  let include: readonly string[] | undefined;
  let remap: Readonly<Record<string, string>> | undefined;
  if (options !== undefined) {
    const target = readRecord(options, "Library import options");
    const rawInclude: unknown = readOnce(target, "include");
    if (rawInclude !== undefined) include = readIncludeList(rawInclude);
    const rawRemap: unknown = readOnce(target, "remap");
    if (rawRemap !== undefined) remap = readRemapTable(rawRemap);
  }

  return createImportRecord({
    kind: "library",
    libraryName,
    libraryVersion,
    defaultIds: snapshot.ids,
    capabilities: snapshot.capabilities,
    ...(include === undefined ? {} : { include }),
    ...(remap === undefined ? {} : { remap }),
  });
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

type Declaration = {
  readonly capability: AnyCapability;
  readonly provenance: CapabilityDeclarationProvenance;
};

function collectLocalDeclarations(
  local: unknown,
  effectiveIds: string[],
  declarations: Map<string, Declaration[]>,
): void {
  if (local === undefined) return;
  const source = readRecord(local, "A local capability map");
  for (const localId of Object.keys(source)) {
    const capability = readOnce(source, localId);
    if (capability === undefined) continue;
    pushDeclaration(effectiveIds, declarations, localId, {
      capability: capability as AnyCapability,
      provenance: { kind: "local", localId },
    });
  }
}

function pushDeclaration(
  effectiveIds: string[],
  declarations: Map<string, Declaration[]>,
  effectiveId: string,
  declaration: Declaration,
): void {
  const existing = declarations.get(effectiveId);
  if (existing === undefined) {
    effectiveIds.push(effectiveId);
    declarations.set(effectiveId, [declaration]);
    return;
  }
  existing.push(declaration);
}

function collectLibraryDeclarations(
  record: LibraryImportRecord,
  effectiveIds: string[],
  declarations: Map<string, Declaration[]>,
  issues: CapabilityCompositionIssue[],
): void {
  const defaultIds = record.defaultIds;
  const known = new Set(defaultIds);
  const include = record.include;
  const selected = include === undefined ? undefined : new Set<string>();
  if (include !== undefined && selected !== undefined) {
    for (let index = 0; index < include.length; index += 1) {
      const defaultId = include[index] as string;
      if (known.has(defaultId)) selected.add(defaultId);
      else {
        issues.push({
          code: "CAPABILITY_IMPORT_ID_NOT_FOUND",
          libraryName: record.libraryName,
          defaultId,
        });
      }
    }
  }

  const remap = record.remap;
  if (remap !== undefined) {
    for (const defaultId of Object.keys(remap)) {
      if (!known.has(defaultId)) {
        issues.push({
          code: "CAPABILITY_IMPORT_ID_NOT_FOUND",
          libraryName: record.libraryName,
          defaultId,
        });
      } else if (selected !== undefined && !selected.has(defaultId)) {
        issues.push({
          code: "CAPABILITY_REMAP_NOT_SELECTED",
          libraryName: record.libraryName,
          defaultId,
        });
      }
    }
  }

  for (let index = 0; index < defaultIds.length; index += 1) {
    const defaultId = defaultIds[index] as string;
    if (selected !== undefined && !selected.has(defaultId)) continue;
    const capability = record.capabilities[defaultId];
    if (capability === undefined) continue;
    pushDeclaration(
      effectiveIds,
      declarations,
      remap?.[defaultId] ?? defaultId,
      {
        capability,
        provenance: {
          kind: "library",
          libraryName: record.libraryName,
          libraryVersion: record.libraryVersion,
          defaultId,
        },
      },
    );
  }
}

function collectImportDeclarations(
  imports: unknown,
  effectiveIds: string[],
  declarations: Map<string, Declaration[]>,
  issues: CapabilityCompositionIssue[],
): void {
  if (imports === undefined) return;
  if (!Array.isArray(imports)) {
    throw new TypeError("Composition imports must be an array.");
  }
  rejectProxy(imports, "Composition imports");
  for (let index = 0; index < imports.length; index += 1) {
    const entry: unknown = imports[index];
    if (!hasBrand(entry, capabilityImportBrand)) {
      throw new TypeError(
        "Every composition import must be created by importCapability or importCapabilities.",
      );
    }
    const record = entry as ImportRecord;
    if (record.kind === "atomic") {
      if (!record.valid) {
        issues.push({
          code: "CAPABILITY_IMPORT_INVALID",
          importKind: "atomic",
          reason: "EXPORTED_CAPABILITY_REQUIRED",
        });
        continue;
      }
      pushDeclaration(effectiveIds, declarations, record.effectiveId, {
        capability: record.capability,
        provenance: record.provenance,
      });
      continue;
    }
    collectLibraryDeclarations(record, effectiveIds, declarations, issues);
  }
}

export function composeCapabilities<
  const Local extends CapabilityMap = Record<never, AnyCapability>,
  const Imports extends readonly AnyCapabilityImport[] = readonly [],
>(
  declaration: {
    readonly local?: Local;
    readonly imports?: Imports;
  } & CompositionDiagnostics<Local, Imports>,
): ComposedCapabilities<ComposedEntries<Local, Imports>> {
  const target = readRecord(declaration, "A capability composition");
  const effectiveIds: string[] = [];
  const declarations = new Map<string, Declaration[]>();
  const issues: CapabilityCompositionIssue[] = [];

  collectLocalDeclarations(
    readOnce(target, "local"),
    effectiveIds,
    declarations,
  );
  collectImportDeclarations(
    readOnce(target, "imports"),
    effectiveIds,
    declarations,
    issues,
  );

  const collided: string[] = [];
  for (let index = 0; index < effectiveIds.length; index += 1) {
    const effectiveId = effectiveIds[index] as string;
    if ((declarations.get(effectiveId)?.length ?? 0) > 1) {
      collided.push(effectiveId);
    }
  }
  if (collided.length > 0 || issues.length > 0) {
    collided.sort(compareCodeUnits);
    const collisions = collided.map(
      (effectiveId): CapabilityCompositionIssue => ({
        code: "CAPABILITY_ID_COLLISION",
        effectiveId,
        declarations: (declarations.get(effectiveId) as Declaration[]).map(
          (entry) => entry.provenance,
        ),
      }),
    );
    throw new CapabilityCompositionError([...collisions, ...issues]);
  }

  const composed: Record<string, AnyCapability> = {};
  for (let index = 0; index < effectiveIds.length; index += 1) {
    const effectiveId = effectiveIds[index] as string;
    const group = declarations.get(effectiveId);
    if (group === undefined) continue;
    composed[effectiveId] = (group[0] as Declaration).capability;
  }
  return Object.freeze(
    brand(composed, composedCapabilitiesBrand),
  ) as unknown as ComposedCapabilities<ComposedEntries<Local, Imports>>;
}

export function isComposedCapabilities(value: unknown): boolean {
  return hasBrand(value, composedCapabilitiesBrand);
}
