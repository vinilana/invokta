import type { CapabilityImport } from "./composition.js";
import type { AnyCapability, CapabilityMap } from "./types.js";

/**
 * The composed map is presented to `createEngine` as a flat object type, so the
 * intersection accumulated over the imports tuple is folded once at the end.
 */
type Flatten<Entries> = { readonly [Key in keyof Entries]: Entries[Key] };

export type ImportEntries<Import> =
  Import extends CapabilityImport<infer Entries> ? Entries : never;

export type ImportEffectiveIds<Import> = Extract<
  keyof ImportEntries<Import>,
  string
>;

type AccumulateEntries<
  Imports extends readonly unknown[],
  Accumulated,
> = Imports extends readonly [infer Head, ...infer Tail]
  ? AccumulateEntries<Tail, Accumulated & ImportEntries<Head>>
  : Accumulated;

export type ComposedEntries<
  Local extends CapabilityMap,
  Imports extends readonly unknown[],
> =
  Flatten<AccumulateEntries<Imports, Local>> extends infer Entries
    ? Entries extends CapabilityMap
      ? Entries
      : CapabilityMap
    : CapabilityMap;

/**
 * A computed ID widens to `string`, which would match every other declaration.
 * Only literal IDs take part in the static gate; the runtime pass stays
 * authoritative for everything else.
 */
type LiteralIds<Ids> = string extends Ids ? never : Ids & string;

/**
 * Duplicates are accumulated over key unions rather than merged objects: an
 * object merge would collapse the very keys the gate has to observe, and a
 * union fold keeps the instantiation depth proportional to the imports tuple.
 */
type AccumulateDuplicates<
  Imports extends readonly unknown[],
  Seen extends string,
  Duplicates extends string,
> = Imports extends readonly [infer Head, ...infer Tail]
  ? AccumulateDuplicates<
      Tail,
      Seen | LiteralIds<ImportEffectiveIds<Head>>,
      Duplicates | Extract<LiteralIds<ImportEffectiveIds<Head>>, Seen>
    >
  : Duplicates;

export type DuplicateEffectiveIds<
  Local extends CapabilityMap,
  Imports extends readonly unknown[],
> = AccumulateDuplicates<Imports, LiteralIds<keyof Local>, never>;

export type CompositionDiagnostics<
  Local extends CapabilityMap,
  Imports extends readonly unknown[],
> = [DuplicateEffectiveIds<Local, Imports>] extends [never]
  ? unknown
  : {
      readonly "Duplicate effective capability IDs are not allowed": DuplicateEffectiveIds<
        Local,
        Imports
      >;
    };

/**
 * A remap target widened to `string` must escape this gate rather than poison
 * it: a widened target matches every literal sibling, so comparing raw value
 * types would flag legitimate dynamic remaps as duplicates. The distributive
 * filter keeps only literal targets on both sides of the comparison; widened
 * targets stay a runtime concern, as everywhere else in the static gate.
 */
type LiteralRemapTarget<Value> = Value extends string
  ? string extends Value
    ? never
    : Value
  : never;

/**
 * Remap targets are validated inside a single import as well, because a mapped
 * type collapses two default IDs pointing at one effective ID into one key.
 */
export type DuplicateRemapTargets<Remap> = {
  [Key in keyof Remap]: Extract<
    LiteralRemapTarget<Remap[Key]>,
    LiteralRemapTarget<Remap[Exclude<keyof Remap, Key>]>
  >;
}[keyof Remap];

export type RemapDiagnostics<Remap> = [DuplicateRemapTargets<Remap>] extends [
  never,
]
  ? unknown
  : {
      readonly "Duplicate remap target capability IDs are not allowed": DuplicateRemapTargets<Remap>;
    };

export type SelectedEntries<
  Capabilities extends CapabilityMap,
  Include extends readonly string[],
> = Flatten<Pick<Capabilities, Extract<Include[number], keyof Capabilities>>>;

export type RemappedEntries<Entries, Remap> = {
  readonly [Key in Extract<keyof Entries, string> as Key extends keyof Remap
    ? Remap[Key] extends string
      ? Remap[Key]
      : Key
    : Key]: Entries[Key];
};

export type EntriesOf<Value> = Value extends CapabilityMap
  ? Value
  : Readonly<Record<string, AnyCapability>>;
