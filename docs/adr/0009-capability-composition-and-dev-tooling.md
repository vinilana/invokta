# ADR 0009: Capability composition and development tooling

- Status: Accepted
- Date: 2026-07-28

## Context

Reusable capability exports need explicit provenance and collision handling.
Plain object spread can silently replace a capability and its access rule, while
a runtime plugin system would violate the visible composition boundary.

## Decision

`@invokta/core` provides `composeCapabilities`, an eager, synchronous, immutable
constructor for the same `CapabilityMap` accepted by `createEngine`. Inputs are
values imported explicitly by the application. Composition performs no I/O,
discovery, initialization, handler execution, or adapter startup.

Every duplicate effective capability ID fails before engine construction. There
is no precedence, deduplication, implicit namespace, or declaration-order rule.
Validation reports all detectable issues deterministically with effective IDs
and declared provenance through a `CapabilityCompositionError`. Composition
errors are construction-time `TypeError`s and do not extend `EngineError`.

Literal inputs receive best-effort TypeScript diagnostics, but runtime
validation is authoritative because computed or widened IDs escape static
analysis. `@invokta/tooling` exposes
`invokta check-capabilities <esm-module>` as the development-time build gate for
a real composed module. It delegates validation to the core, emits payload-free
diagnostics, and never invokes a capability or starts a transport.

Composition metadata is diagnostic data, not a sandbox, signature, permission
manifest, or compatibility guarantee. Imported capabilities are executable code
with the same trust level as any other dependency. Dependencies continue to
enter through factories and the application composition root.

This decision does not introduce package discovery, a service locator,
dependency injection container, mutable registration, lifecycle hooks, hot
loading, or remote composition.

## Consequences

- Capability libraries can be reused without a second execution path.
- Collision safety is deterministic when composition provenance is preserved.
- Raw maps already flattened with object spread cannot recover overwritten
  provenance and must not be presented as safe composition.
- Dynamic compositions require the build gate in continuous integration.
