# Capability libraries and collision-safe composition

- Status: Draft
- Target: Post-v0.1
- Change type: Additive public API and tooling
- Date: 2026-07-28

## Summary

AI Engine applications need to reuse domain capabilities published by community
packages without copying handlers or introducing runtime plugin discovery. A
capability library is a normal ESM package that exports capability definitions or
dependency-injected factories. An engine imports those values explicitly and
composes them before calling `createEngine`.

Each library capability has a default ID. An importing engine may remap that ID
to a different effective ID. The effective ID is the only ID exposed by the
engine through direct invocation, CLI, MCP, events, access rules, `list`, and
`describe`.

Composition must never use last-write-wins behavior. The framework must retain
the provenance of local and imported capabilities, report every detectable
effective-ID collision, and reject the composition before an engine or adapter
can start. Statically known collisions should also fail type checking. A build
tool must provide the authoritative check for dynamic compositions.

## Relationship to the existing architecture

This specification extends the framework after v0.1. It does not retroactively
change the v0.1 contract.

The design preserves the existing architectural direction:

- imports are explicit ESM imports at the application composition boundary;
- capability dependencies enter through factories and custom-engine ports;
- imported capabilities still pass through `createEngine` and the single
  `engine.invoke` pipeline;
- the core has no package registry, service locator, dependency container,
  lifecycle manager, reflection, hot loading, or remote discovery;
- a capability library cannot initialize CLI, MCP, HTTP, or other adapters;
- community libraries are user-owned packages, not framework-owned providers.

Implementation requires a new ADR that authorizes post-v0.1 capability
composition and the dev-only tooling package. The ADR must clarify that an eager,
immutable composition descriptor is not a runtime module system with discovery
or initialization hooks.

## Goals

1. Let a community package publish one or more reusable capabilities.
2. Preserve literal input and output inference when a capability is imported.
3. Give each exported capability a stable default ID.
4. Let an importing engine replace the default ID without mutating the library.
5. Detect collisions across local capabilities, library imports, and remapped
   IDs before an engine is usable.
6. Produce deterministic, actionable diagnostics that identify every conflicting
   declaration.
7. Keep dependencies, initialization, and ownership visible in the engine's
   composition root.
8. Preserve the existing `engine.invoke` execution path for direct, CLI, and MCP
   consumers.

## Non-goals

- Installing packages or resolving package versions.
- A marketplace, remote registry, search API, or package discovery protocol.
- Runtime plugin loading, unloading, or hot replacement.
- Dependency injection, lifecycle, or configuration containers.
- Automatic capability ID namespacing.
- Automatic conflict resolution, priority, replacement, or deduplication.
- Invoking a remote engine or composing already-created `Engine` instances.
- Merging schemas, access rules, handlers, annotations, or timeouts.
- Negotiating contract compatibility between an engine and a library.

## Terminology

**Capability library**
: A versioned ESM package value containing a diagnostic name, version, and a map
  of default capability IDs to capability definitions. A factory may create the
  value after the importing application supplies dependencies.

**Default ID**
: The capability ID selected by the library author and used when the importer
  does not provide a remap.

**Effective ID**
: The ID under which the importing engine registers and exposes the capability.
  It is either the default ID or the explicit remap target.

**Import descriptor**
: An immutable composition input that identifies a library, an optional subset
  of capabilities, and zero or more default-ID-to-effective-ID remaps.

**Composition provenance**
: Diagnostic metadata that relates an effective ID to its local declaration or
  library name, library version, and default ID. Provenance is tooling metadata;
  it is not added to `ExecutionContext` or capability schemas.

## Proposed public API

The exact generic implementation may differ, but the following user-facing
operations and inference behavior are normative:

```ts
import {
  composeCapabilities,
  defineCapability,
  defineCapabilityLibrary,
  importCapabilities,
} from "@ai-engine/core";

export function createSupportCapabilityLibrary(
  dependencies: SupportCapabilityDependencies,
) {
  return defineCapabilityLibrary({
    name: "@community/support-capabilities",
    version: "1.4.0",
    capabilities: {
      "support.classify-ticket": defineCapability({
        description: "Classify a support ticket.",
        input: classifyTicketInput,
        output: classifyTicketOutput,
        access: ({ principal, input }) =>
          principal !== null &&
          dependencies.permissions.can(
            principal,
            "ticket:classify",
            input.ticketId,
          ),
        async run({ input, context }) {
          const ticket = await dependencies.tickets.findById(input.ticketId);
          return dependencies.classifier.classify(ticket, {
            signal: context.signal,
          });
        },
      }),
    },
  });
}
```

The consuming engine composes local and imported capabilities explicitly:

```ts
import {
  composeCapabilities,
  createEngine,
  importCapabilities,
} from "@ai-engine/core";
import {
  createSupportCapabilityLibrary,
} from "@community/support-capabilities";

const supportLibrary = createSupportCapabilityLibrary(dependencies.support);

export const capabilities = composeCapabilities({
  local: {
    "operations.generate-report": createGenerateReport(dependencies.reports),
  },
  imports: [
    importCapabilities(supportLibrary, {
      include: ["support.classify-ticket"],
      remap: {
        "support.classify-ticket": "operations.classify-ticket",
      },
    }),
  ],
});

export const engine = createEngine({
  name: "operations-engine",
  version: "2.0.0",
  capabilities,
});
```

`defineCapabilityLibrary` and `importCapabilities` describe composition. They do
not register global state, resolve packages, initialize dependencies, or create
an engine. `composeCapabilities` eagerly resolves the descriptors into the
ordinary capability map consumed by `createEngine`.

### Library definition

**AE-LIB-01 — ESM value.** A capability library MUST be an explicitly imported
ESM value. The framework MUST NOT discover installed packages or scan the file
system.

**AE-LIB-02 — Identity.** A library MUST declare a non-empty diagnostic `name`, a
non-empty `version`, and a capability map. The framework treats `name` and
`version` as opaque diagnostic strings and does not perform package or semantic
version resolution.

**AE-LIB-03 — Default IDs.** The keys of the library capability map are its
default IDs. The ID remains outside each `CapabilityDefinition`, preserving the
existing minimal capability contract.

**AE-LIB-04 — Explicit dependencies.** A library with repositories, providers,
models, policy checks, or other dependencies SHOULD expose a factory that accepts
engine-owned ports. It MUST NOT acquire dependencies from `ExecutionContext`, a
global registry, or a framework service locator.

**AE-LIB-05 — No adapters.** A capability library MUST NOT start or configure an
official adapter as a side effect of definition or import.

### Import selection and ID remapping

**AE-COMP-01 — Explicit selection.** `importCapabilities` MUST accept a library
and MAY accept an `include` list. Omitting `include` imports every capability in
the library. Providing `include` imports exactly the listed default IDs.

**AE-COMP-02 — Remap.** The importer MAY provide a `remap` object from selected
default IDs to effective IDs. An absent entry preserves the default ID. Remapping
does not mutate the library, create an alias, or retain the original ID in the
engine.

**AE-COMP-03 — Valid references.** Every `include` entry and every `remap` key
MUST identify a default ID present in the library. When `include` is present,
every `remap` key MUST also be selected. Statically known invalid references MUST
fail type checking; dynamic invalid references MUST fail composition.

**AE-COMP-04 — Effective public ID.** The effective ID MUST be used by:

- `engine.invoke`, `list`, and `describe`;
- capability access rules through `capabilityId`;
- invocation events;
- CLI capability selection;
- MCP tool names and error mapping.

The default ID and library provenance MUST NOT be added to `ExecutionContext`,
business inputs, outputs, or invocation events.

**AE-COMP-05 — Multiple mounts.** The same library capability MAY be imported
more than once when every import has a distinct effective ID. Each mount is a
separate engine capability contract. Object identity MUST NOT cause automatic
deduplication.

**AE-COMP-06 — Type preservation.** For statically known libraries and remaps,
the composed capability map MUST preserve literal effective IDs and each
capability's input and output types. A remapped default ID MUST no longer be an
accepted typed `invoke` ID unless it is separately mounted.

**AE-COMP-07 — Definition preservation.** Selection and remapping MUST change
only registration membership and the effective ID. They MUST NOT alter the
capability title, description, schemas, access rule, timeout, annotations, or
handler. Input and output validation, authorization, cancellation, timeout,
error normalization, and event delivery MUST behave exactly as they do for a
local capability registered directly with `createEngine`.

### Collision behavior

**AE-COLLISION-01 — Complete surface.** Composition MUST detect duplicate
effective IDs across:

- local capabilities and imports;
- two or more imports;
- default IDs and remap targets;
- two remap targets;
- repeated imports of the same library or capability.

**AE-COLLISION-02 — No precedence.** Declaration order, import order, library
version, and object identity MUST NOT resolve a collision. There is no
last-write-wins or first-write-wins behavior.

**AE-COLLISION-03 — Construction failure.** A collision MUST fail synchronously
during composition, before `createEngine` returns and before an adapter can
listen. No capability involved in an invalid composition may be invoked.

**AE-COLLISION-04 — Complete diagnostics.** One validation pass MUST report all
detectable collisions rather than stopping at the first. Issues MUST be sorted by
effective ID. Declarations within an issue MUST retain composition order.

**AE-COLLISION-05 — Provenance.** Every collision issue MUST contain the
effective ID and every conflicting declaration. A local declaration identifies
the engine-local source and local ID. An imported declaration identifies the
library name, library version, and default ID. Diagnostics MUST NOT contain
capability inputs, outputs, credentials, dependency values, or handler source.

**AE-COLLISION-06 — Untracked spreads.** The collision guarantee applies only
while source boundaries remain available to `composeCapabilities`. Passing a map
that has already overwritten IDs through raw object spread loses provenance and
MUST NOT be documented as safe composition. The build checker MUST reject an
unbranded, already-flattened map when it is presented as a library composition.

### Composition errors

Invalid composition MUST throw a `CapabilityCompositionError` that extends
`TypeError`. It is a construction error, not an invocation `EngineError`, and
does not expand the seven-code invocation error taxonomy.

```ts
interface CapabilityCompositionError extends TypeError {
  readonly code: "CAPABILITY_COMPOSITION_INVALID";
  readonly issues: readonly CapabilityCompositionIssue[];
}

type CapabilityCompositionIssue =
  | {
      readonly code: "CAPABILITY_ID_COLLISION";
      readonly effectiveId: string;
      readonly declarations: readonly CapabilityDeclarationProvenance[];
    }
  | {
      readonly code: "CAPABILITY_IMPORT_ID_NOT_FOUND";
      readonly libraryName: string;
      readonly defaultId: string;
    }
  | {
      readonly code: "CAPABILITY_REMAP_NOT_SELECTED";
      readonly libraryName: string;
      readonly defaultId: string;
    };
```

The stable public message is `Capability composition is invalid.` Tooling and
tests MUST use `code` and `issues`, not parse the message. The error and its issue
data MUST be immutable snapshots that cannot alter later successful
compositions.

Composition performs no I/O and has no retry behavior. Runtime work and memory
MUST be linear in the number of local declarations, selected imports, and remap
entries. No fixed capability-count limit is introduced by this specification.

## Type-check and build validation

Collision detection has two complementary gates.

### Static gate

When all IDs are literal types, `composeCapabilities` MUST make duplicate
effective IDs, unknown `include` entries, and unknown `remap` keys TypeScript
errors. Type-level validation is an early developer diagnostic and MUST preserve
the inferred `Engine` input and output types.

Dynamic strings and computed maps may escape static analysis. Runtime/build
validation remains authoritative.

### Build gate

A new dev-only `@ai-engine/tooling` package MUST provide:

```text
ai-engine check-capabilities <esm-module> [--export <name>]
```

The default export name inspected by the command is `capabilities`. The selected
export MUST be the result of `composeCapabilities`; an untracked raw map fails
validation. The module is trusted application build input and MUST be built to
ESM before the command runs. A dedicated, side-effect-free composition module is
recommended.

The command MUST:

1. import the requested module without starting an engine adapter;
2. verify that the selected export carries framework composition provenance;
3. run the same validation semantics used by `composeCapabilities`;
4. print deterministic, payload-free diagnostics to `stderr`;
5. produce no `stdout` output;
6. exit `0` for a valid composition, `1` for composition issues, and `2` for
   invalid usage, module loading failure, or a missing/wrong export;
7. report every collision issue in one run.

The core MUST NOT depend on `@ai-engine/tooling`. Tooling may depend only on the
core public composition API and Node ESM facilities. The command does not invoke
capabilities, initialize their dependencies, or start CLI/MCP transports beyond
the application code executed by the imported module itself.

## Ordering and determinism

For a valid composition, local capabilities precede imports. Imports retain the
order of the `imports` array, and selected capabilities retain their library map
order. Remapping changes only the key, not the declaration position.

The existing engine behavior determines how `list` exposes the resolved map.
Composition MUST produce the same resolved key order in repeated runs over the
same local map, imports, selections, and remaps.

## Versioning and compatibility

- Adding the composition API is additive for existing v0.1 engines.
- Existing engines may continue to pass a direct capability map to
  `createEngine`.
- Engines consuming community libraries MUST use the collision-safe composition
  API to claim the guarantees in this specification.
- Changing a library default ID is a breaking library change.
- Changing an engine remap target is a breaking engine change because direct,
  CLI, and MCP consumers observe the effective ID.
- Changing an imported capability's input, output, access behavior, stable public
  errors, or semantics follows the same compatibility rules as changing a local
  capability.
- A library implementation change that preserves its capability contracts may
  be adopted without changing engine call sites.
- Library versions are resolved by the host package manager, not the framework.

## Security and trust

A capability library is executable application code with the same trust level as
any other installed dependency. Composition metadata is not a sandbox or a
supply-chain security mechanism. Package signing, provenance attestation,
permission manifests, and capability sandboxing remain unspecified.

Import and collision diagnostics must never evaluate `run`, call an access rule,
or serialize dependency values. Only IDs and declared diagnostic provenance may
be reported.

## Acceptance criteria

| ID | Observable outcome | Minimum evidence |
| --- | --- | --- |
| `AE-AC-01` | One library factory is reused by two engines with different dependency implementations and no shared framework state. | Runtime test with two engines and distinct outputs. |
| `AE-AC-02` | Importing without `remap` registers the default ID. | Type test plus `list`, `describe`, and direct invocation test. |
| `AE-AC-03` | Importing with `remap` registers only the effective ID. | Type test proving the original ID is rejected and runtime test returning `CAPABILITY_NOT_FOUND` for an unmounted original ID. |
| `AE-AC-04` | The effective ID reaches access rules, events, CLI, and MCP. | Core, CLI, and MCP integration tests. |
| `AE-AC-05` | Local/import, import/import, default/remap, and remap/remap collisions all fail before engine creation. | Table-driven runtime contract tests. |
| `AE-AC-06` | A repeated identical capability object under the same effective ID still collides. | Runtime regression test. |
| `AE-AC-07` | All collisions are returned in deterministic order with complete, payload-free provenance. | Snapshot-free structural error assertions and log safety test. |
| `AE-AC-08` | Unknown selections and remaps fail statically when literal and dynamically otherwise. | Public type tests and runtime boundary tests. |
| `AE-AC-09` | Literal remapped IDs preserve exact invocation input and output inference. | Public API type test. |
| `AE-AC-10` | `ai-engine check-capabilities` exits `0`, `1`, and `2` for valid, colliding, and invalid-tooling fixtures respectively. | Child-process tooling tests. |
| `AE-AC-11` | The build checker rejects an untracked raw map instead of claiming collision safety. | Tooling fixture using pre-flattened object spread. |
| `AE-AC-12` | Imported capabilities execute through the same `engine.invoke` path across all adapters. | Adapter spies and an end-to-end community-library example. |
| `AE-AC-13` | A dynamically generated composition of 10,000 declarations is validated without stack overflow and without executing access rules or handlers. | Instrumented runtime test using computed IDs. |
| `AE-AC-14` | Importing and remapping preserve schemas, access, timeout, annotations, cancellation, outputs, and normalized failures. | Core contract tests comparing local and imported registrations. |

## Traceability

| Requirement | Contract surface | Acceptance evidence |
| --- | --- | --- |
| Reusable community capabilities | `defineCapabilityLibrary`, explicit dependency factories | `AE-AC-01`, `AE-AC-12` |
| Default and overridden IDs | `importCapabilities.include` and `remap` | `AE-AC-02`, `AE-AC-03`, `AE-AC-04` |
| Collision safety | `composeCapabilities`, `CapabilityCompositionError` | `AE-AC-05` through `AE-AC-09` |
| Lint/build enforcement | `@ai-engine/tooling`, `check-capabilities` | `AE-AC-10`, `AE-AC-11` |
| Architectural boundaries | ESM imports, composition root, unchanged `engine.invoke` | `AE-AC-01`, `AE-AC-12` through `AE-AC-14` |

## Delivery slices

1. Record the post-v0.1 architecture decision and version target.
2. Add library and import descriptor types with public type tests.
3. Implement collision-safe composition and construction errors using RED,
   GREEN, REFACTOR.
4. Add effective-ID behavior to direct engine contract tests.
5. Add the dev-only tooling package and build fixtures.
6. Add CLI and MCP integration coverage for remapped capabilities.
7. Publish a private example library consumed by two example engines before
   documenting the community authoring workflow.

Each slice must be a separate validated work item and cohesive commit.

## Deferred and unspecified

The following remain intentionally unspecified and require separate evidence and
decisions:

- marketplace discovery and community package indexing;
- library trust, signing, and permission declarations;
- compatibility negotiation between library and engine versions;
- transitive library manifests or dependency graphs;
- automatic aliases or deprecation redirects for renamed IDs;
- hot reload and dynamic enablement;
- remote or distributed capability composition.
