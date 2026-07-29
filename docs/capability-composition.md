# Authoring and composing community capabilities

A capability is defined once and executed through `engine.invoke`. Composition
extends that model to capabilities an engine did not write: a local ESM module
or an installed package publishes a capability, and the consuming engine imports
it explicitly at its composition root.

Every published capability carries a **default ID** chosen by its author. The
importing engine may keep that ID or replace it with an **effective ID**. The
effective ID is the only identity the framework exposes: `invoke`, `list`,
`describe`, `capabilityId` in access rules, invocation events, CLI selection,
and MCP tool names all use it. Default IDs and source metadata never reach
`ExecutionContext`, business inputs, outputs, or events.

Composition is eager and synchronous. It performs no I/O, starts no adapter,
never calls `run` or an access rule, and produces the same plain capability map
`createEngine` already accepts. There is no registry, container, discovery, or
plugin lifecycle.

## Publish one atomic capability

A module that publishes a single capability wraps it with
`defineExportedCapability`. Dependencies enter through a factory that receives
engine-owned ports, never from `ExecutionContext` or a global:

```ts
import { defineExportedCapability } from "@invokta/core";

import type { ClassifyTicketDependencies } from "./application/ports.js";
import { createClassifyTicket } from "./capabilities/classify-ticket.js";

export function createClassifyTicketExport(
  dependencies: ClassifyTicketDependencies,
) {
  return defineExportedCapability({
    source: {
      name: "@invokta/example-community-capabilities/classify-ticket",
      version: "1.4.0",
    },
    defaultId: "community.classify-ticket",
    capability: createClassifyTicket(dependencies),
  });
}
```

`source.name` and `source.version` are opaque diagnostic strings. The framework
never resolves, compares, or interprets them. `defineExportedCapability` throws
`TypeError` synchronously for an empty name, an empty provided version, or an
empty default ID, and freezes the descriptor so a later mutation cannot change a
composition that already ran.

The value may be published from a relative local module, a package root export,
or a package subpath export. All three produce the same framework value; Node
and the package manager remain responsible for resolution. A package that
publishes an atomic capability from a subpath must not force importers to
evaluate an unrelated library bundle, so keep the subpath's module graph free of
the bundle.

A stateless capability may be exported as a constant descriptor instead of a
factory. A plain `CapabilityDefinition` is still valid in an engine's `local`
map, but it has no default ID and no provenance, so `importCapability` rejects
it — statically when its type is known, and as a composition issue otherwise.

## Publish a capability library

A package that publishes a related set of capabilities exposes a library value:

```ts
import { defineCapabilityLibrary } from "@invokta/core";

export function createCommunitySupportLibrary(
  dependencies: CommunityLibraryDependencies,
) {
  return defineCapabilityLibrary({
    name: "@invokta/example-community-capabilities/library",
    version: "1.4.0",
    capabilities: {
      "community.summarize-thread": createSummarizeThread(dependencies),
      "community.search-knowledge-base":
        createSearchKnowledgeBase(dependencies),
      "community.draft-reply": createDraftReply(dependencies),
    },
  });
}
```

The map keys are the library's default IDs; the ID stays outside each
`CapabilityDefinition`. The key order is part of the published contract, because
selected capabilities keep their position in the composed map.

A library that needs repositories, providers, models, or policy checks must
accept them through its factory. It must not read them from `ExecutionContext`,
a global registry, or a service locator, and it must not start or configure an
adapter as a side effect of definition or import. One factory can therefore be
called twice with different implementations to build two independent engines
that share no framework state.

## Choose default IDs

Default IDs are public API. Choose them the same way you choose a local
capability ID:

- name the domain operation, not the package (`support.classify-ticket`, not
  `acme-sdk.run`);
- use literal string keys so the static gate can see them;
- keep them stable — changing an atomic export's default ID breaks every
  importer that did not pin an `as` target, and changing a library default ID is
  a breaking library change.

The framework never derives an ID from an export name, file name, package name,
handler name, title, or description.

## Consume an atomic export

```ts
import {
  composeCapabilities,
  createEngine,
  importCapability,
} from "@invokta/core";
import {
  createScoreTicketPriorityExport,
} from "@invokta/example-community-capabilities";
import {
  createClassifyTicketExport,
} from "@invokta/example-community-capabilities/classify-ticket";

export const capabilities = composeCapabilities({
  local: {
    "operations.generate-report": createGenerateReport(dependencies.reports),
  },
  imports: [
    importCapability(createScoreTicketPriorityExport(dependencies.community)),
    importCapability(createClassifyTicketExport(dependencies.community), {
      as: "operations.classify-ticket",
    }),
  ],
});
```

Omitting `as` keeps the default ID. Providing `as` **replaces** it: the default
ID is gone from the engine, `invoke` rejects it with `CAPABILITY_NOT_FOUND`, and
the type of `invoke` no longer accepts it. Mounting one capability under two IDs
requires two explicit import descriptors with two distinct effective IDs.

## Consume a library

```ts
import { composeCapabilities, importCapabilities } from "@invokta/core";
import {
  createCommunitySupportLibrary,
} from "@invokta/example-community-capabilities/library";

export const capabilities = composeCapabilities({
  imports: [
    importCapabilities(createCommunitySupportLibrary(dependencies.community), {
      include: ["community.search-knowledge-base", "community.draft-reply"],
      remap: { "community.draft-reply": "operations.draft-reply" },
    }),
  ],
});
```

- Omitting `include` imports every capability in the library. Providing
  `include` imports exactly the listed default IDs.
- `remap` maps a selected default ID to an effective ID. An absent entry keeps
  the default ID. When `include` is present, every `remap` key must also be
  selected.
- Selection and remapping change only registration membership and the key. They
  never alter the title, description, schemas, access rule, timeout,
  annotations, or handler, and the invocation pipeline behaves exactly as it
  does for a locally registered capability.
- Selected capabilities keep the library map's order; remapping changes the key,
  not the position.

`importCapabilities` requires a real `defineCapabilityLibrary` descriptor and
throws a plain `TypeError` immediately for anything else. `importCapability`
accepts an unbranded value at the call site and reports it as a composition
issue instead, which is why an unchecked value reaches `composeCapabilities`
before it fails.

## No namespacing, no precedence

Composition never prefixes an imported capability with its source or library
name. Automatic namespacing would hide collisions instead of reporting them and
would make a public capability ID depend on a string the framework treats as
opaque metadata. The importer chooses the effective ID explicitly.

Composition also has no precedence rule. Declaration order, import order, source
or library version, and object identity never resolve a duplicate. There is no
last-write-wins, no first-write-wins, no priority, and no identity deduplication
— importing the same exported value twice under the same effective ID is a
collision, not a tolerated repetition. Every duplicate effective ID fails
composition synchronously, before `createEngine` returns and before any adapter
can listen.

Duplicates are detected across local capabilities, atomic imports, library
imports, default IDs, atomic `as` targets, and library `remap` targets, in every
combination.

## Raw object spread is not composition

The collision guarantee holds only while `composeCapabilities` can still see the
source boundaries. This is **not** safe:

```ts
// Unsafe: the duplicate ID is already gone before the framework sees anything.
const capabilities = {
  ...localCapabilities,
  ...communityCapabilities,
};
```

A map flattened through raw object spread has already lost its provenance. The
second `community.classify-ticket` silently overwrote the first, the surviving
handler may carry a different access rule than the one you believed was
registered, and nothing failed. Composition cannot recover what the spread threw
away, so raw spread must never be presented as safe composition. Pass the
imported values to `composeCapabilities` instead and let it own the flattening.

For the same reason, `invokta check-capabilities` rejects an unbranded,
already-flattened map presented as an imported composition rather than
reporting it as valid. `isComposedCapabilities(value)` reports whether a value
carries the framework's composition provenance.

## Read a CapabilityCompositionError

An invalid composition throws a `CapabilityCompositionError`, which extends
`TypeError`. It is a construction error, not an invocation `EngineError`, and it
does not extend the seven-code invocation taxonomy: a composition failure has no
request ID, no event, and no transport mapping.

```ts
import { isCapabilityCompositionError } from "@invokta/core";

try {
  createEngine({ name, version, capabilities: composeCapabilities(plan) });
} catch (error) {
  if (!isCapabilityCompositionError(error)) throw error;
  for (const issue of error.issues) {
    process.stderr.write(`${JSON.stringify(issue)}\n`);
  }
}
```

The error carries `code: "CAPABILITY_COMPOSITION_INVALID"` and an immutable
`issues` array. One validation pass reports every detectable issue, so a run
never stops at the first problem. The issue codes are:

| Code | Meaning |
| --- | --- |
| `CAPABILITY_ID_COLLISION` | Two or more declarations claim one effective ID. |
| `CAPABILITY_IMPORT_INVALID` | `importCapability` received a bare definition. |
| `CAPABILITY_IMPORT_ID_NOT_FOUND` | `include` or `remap` names an unknown ID. |
| `CAPABILITY_REMAP_NOT_SELECTED` | A `remap` key was not selected by `include`. |

`CAPABILITY_IMPORT_INVALID` covers any value handed to `importCapability` that
did not come from `defineExportedCapability`, and
`CAPABILITY_IMPORT_ID_NOT_FOUND` covers an `include` entry or a `remap` key that
is not a default ID of the library.

A collision issue carries the `effectiveId` and every conflicting declaration.
A local declaration reports its local ID; an atomic declaration reports its
source name, optional source version, and default ID; a library declaration
reports the library name, library version, and default ID. Collision issues come
first, sorted by effective ID, and declarations inside an issue keep composition
order, so diagnostics are reproducible.

Diagnostics are payload-free by construction. They contain only IDs and declared
provenance strings — never a schema, handler, input, output, dependency value,
or credential — so a composition failure can be logged in full. Use `code` and
`issues`; the message is the stable string `Capability composition is invalid.`
and must not be parsed.

`isCapabilityCompositionError` is duck-typed rather than an `instanceof` check,
so it still works when a build resolves two copies of `@invokta/core`.

## Keep the composition in a dedicated module and gate the build

Collision detection has two gates.

The **static gate** runs in TypeScript. When every ID is a literal, duplicate
effective IDs, a bare `CapabilityDefinition` passed to `importCapability`,
unknown `include` entries, and unknown or unselected `remap` keys are type
errors, while `invoke` keeps its exact input and output inference. The static
gate is a fast developer diagnostic, not the guarantee: an ID built from
configuration or widened to `string` is deliberately ignored by it, and types do
not exist at runtime.

The **build gate** is authoritative. Put the composition in its own
side-effect-free module that exports `capabilities`, creates no engine, and
starts nothing:

```ts
// src/capabilities.ts
export const capabilities = createOperationsCapabilities(
  createDefaultOperationsDependencies(),
);
```

Then run the checker over the built module in CI:

```sh
invokta check-capabilities ./dist/capabilities.js
invokta check-capabilities ./dist/capabilities.js --export capabilities
```

The command imports the module without starting an adapter, verifies that the
selected export carries composition provenance, reports every issue in one run
on `stderr`, and writes nothing to `stdout`. It exits `0` for a valid
composition, `1` for composition issues, and `2` for invalid usage, a module
load failure, a missing export, or an untracked raw map. Run it for every engine
that composes imported capabilities; without it, a dynamic composition is
protected only by the best-effort static gate.

## Versioning and compatibility

- The composition API is additive. Existing engines may keep passing a plain
  capability map to `createEngine`; the guarantees above apply only to engines
  that compose through `composeCapabilities`.
- Changing an atomic export's default ID is a breaking change for importers that
  did not pin a stable `as` target.
- Changing a library default ID is a breaking library change.
- Changing an engine's remap target is a breaking engine change, because direct,
  CLI, and MCP consumers observe the effective ID.
- Changing an imported capability's input, output, access behavior, stable
  public errors, or semantics follows the same compatibility rules as changing a
  local capability.
- A library implementation change that preserves its capability contracts can be
  adopted without touching engine call sites.
- Removing or renaming a package root or subpath export is a package API break
  even when the default and effective IDs do not change.
- Atomic source versions and library versions are diagnostic metadata. Installed
  package versions are resolved by the host package manager, not the framework.
- Changing only source metadata does not change the execution contract, but it
  may change tooling diagnostics and stored diagnostic baselines.

## Composition metadata is not a trust boundary

Composition metadata is diagnostic data. It is not a sandbox, a permission
manifest, a signature, an attestation, or a supply-chain security mechanism, and
the framework does not verify any part of it.

An imported atomic export or capability library is executable application code
with the same trust level as any other installed dependency. Importing it grants
it everything the host process already has, before any access rule runs.
Reviewing, pinning, and auditing dependencies remain host responsibilities, and
capability access rules remain responsible for domain authorization.

## Worked example

- [`community-capabilities`](../examples/community-capabilities/) is a private
  fixture package publishing an atomic capability from its root, a second atomic
  capability from a subpath, and a capability library from a third subpath.
- [`composed-engine`](../examples/composed-engine/) consumes all three forms
  next to a local capability and exposes the result through the direct API, the
  CLI, MCP stdio, and MCP HTTP.
