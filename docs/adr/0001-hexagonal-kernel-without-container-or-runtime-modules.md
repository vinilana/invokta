# ADR 0001: Hexagonal kernel without a container or runtime modules

- Status: Accepted
- Date: 2026-07-27

## Context

The kernel must execute the same operations through programmatic calls, CLI, MCP,
and HTTP. If business rules depend on a transport framework, a dependency
injection container, or implicit module registration, each entry point acquires
its own behavior and the composition becomes difficult to test.

In this ADR, “module” means a runtime registration or discovery unit; it does not
refer to the language's ESM modules.

## Decision

`@ai-engine/core` will adopt a hexagonal architecture:

- the kernel will contain capabilities, public types, invariants, and the pipeline;
- model, data, and tool ports will be interfaces of the custom engine, not
  registrations managed by the framework;
- external integrations will be implementations injected into those interfaces;
- dependencies will enter through explicit constructors or factory functions;
- composition will occur at the application boundary, without mutable global
  state;
- dependencies will point from the boundaries toward the core, never from the
  core toward the boundaries.

The kernel will have no port registry, dependency injection container, service
locator, registration decorators, discovery through reflection, or `modules`
system with initialization hooks. Adding a capability or adapter will require
explicit imports and wiring at the composition point.

## Consequences

- The same kernel can be exercised without initializing the CLI, HTTP server, or
  MCP.
- Tests can replace ports with simple test doubles, without container
  infrastructure.
- Dependencies and initialization order remain visible in the code.
- Wiring will be more explicit and, in large compositions, slightly more verbose.
- Framework conveniences may exist only in adapters and must not leak into the
  core's public contracts.
