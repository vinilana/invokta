# ADR 0051: Typed capability middleware composition

- Status: Accepted
- Date: 2026-11-05

## Context

The engine's only cross-cutting extension point is the observe-only `onEvent`
hook (ADR 0003). It cannot block, short-circuit, or replace a result, so audit
logging that needs the principal, rate limiting, caching, idempotency keys, and
timing are rewritten inside every capability's `run` or duplicated across
capability factories. Engines repeat the same wrapper shape: read the request
context, call the handler, and observe or replace its outcome.

ADR 0001 and AE-LIMIT-02 exclude a container, plugin system, or mutable module
lifecycle, and ADR 0003 excludes before/after/onError policies from the
pipeline. A remedy must therefore not register anything with the engine, add a
pipeline stage, or let wrapped code skip validation or authorization.

## Decision

`@invokta/core` exports `applyMiddleware(capabilities, ...middleware)` and the
`CapabilityMiddleware` and `CapabilityMiddlewareArgs` types from a dedicated
module. A middleware is an asynchronous function:

```ts
type CapabilityMiddleware = (args: {
  readonly capabilityId: string;
  readonly input: unknown;
  readonly context: ExecutionContext;
  readonly next: () => Promise<unknown>;
}) => Promise<unknown>;
```

`applyMiddleware` is pure, eager, and synchronous. It reads the capability map
and each capability's top-level fields exactly once, validates that every
middleware is a function and every capability is a non-proxy object with a
`run` function, and returns a new frozen map with the same keys in the same
order. Each wrapped capability is a frozen shallow copy that keeps every other
field by identity, including schemas, `access`, `title`, `description`,
`annotations`, `timeoutMs`, and fields it does not recognize, and replaces only
`run`. It performs no I/O and calls no middleware, access rule, or handler.
Undefined map entries are skipped, as `createEngine` skips them. With no
middleware, the result is a frozen copy holding the original capabilities.
Invalid arguments throw `TypeError` before any engine exists.

Because the composition replaces only `run`, the chain executes inside stage 5
of the unchanged pipeline:

- input is validated and transformed before the chain, and a rejected input
  never reaches a middleware;
- `access` is enforced before the first middleware, so middleware cannot
  bypass authorization;
- the chain receives the execution context created by the engine and passes it
  to `run` unchanged, including its cancellation `signal`;
- the capability timeout and caller cancellation cover the whole chain;
- the outermost middleware's result is validated and transformed against the
  output schema, whether it came from `run` or was produced by a middleware;
- an error thrown or rejected by a middleware is normalized exactly like an
  error from `run`, so a stable `EngineError` is preserved and any other value
  becomes `EXECUTION_FAILED` with an internal cause; and
- events, CLI, MCP, and every other adapter observe one ordinary invocation.

`capabilityId` is the capability's key in the map passed to `applyMiddleware`.
The engine does not pass the ID to `run`, and this decision does not change the
handler signature. Applying middleware to the final composed map therefore
observes effective engine IDs; middleware applied inside a library or atomic
export observes that package's default ID.

Order is deterministic: the first listed middleware is outermost and the
handler is innermost. Applying middleware to a map that already contains
wrapped capabilities places the new chain outside the earlier one.

`next()` takes no arguments, so a middleware cannot replace the validated input
or the context. It resolves to the next layer's unvalidated result and may be
called at most once while its middleware is pending. A repeated call, or a call
after the middleware settled, rejects with `TypeError` without starting the
next layer; if that rejection propagates, the invocation fails as
`EXECUTION_FAILED`. A call after the invocation signal aborted rejects with the
signal reason without starting the next layer, matching the engine's check
before `run`. Like the engine, the chain reads the signal through the platform
accessors, so a wrapped `run` called outside the engine requires a platform
`AbortSignal`. Rejections from `next()` promises that a middleware never awaits
are contained. Retries therefore remain outside the framework, as AE-LIMIT-01
requires.

Each middleware layer of one application receives the same deep-frozen
snapshot of the validated input. `run` still receives the unmodified execution
snapshot, so neither middleware nor caller mutation crosses into execution, in
the same way AE-SCHEMA-02 isolates `access`.

When the source map carries composition provenance, the result keeps it,
because wrapping preserves keys one-to-one and cannot introduce a collision.
A plain or object-spread map is never promoted to a tracked composition, so
`invokta check-capabilities` keeps accepting wrapped compositions and keeps
rejecting untracked maps. Wrapped capabilities can be passed to
`composeCapabilities`, `defineExportedCapability`, and
`defineCapabilityLibrary` like any capability.

Concrete middleware such as audit logging, rate limiting, caching, and
idempotency are not framework exports. The documentation provides tested
recipes and states their single-process and memory limits.

This decision adds no engine option, middleware registry, global or implicit
middleware, priority ordering, discovery, lifecycle, or asynchronous
construction. `createEngine` semantics, the six pipeline stages, the seven
error codes, `ExecutionContext`, and the single `onEvent` hook are unchanged.

## Consequences

- Engines share audit, rate-limit, caching, and timing wrappers without
  duplicating them in every handler and without a second execution path.
- Middleware is explicit composition at the application root: reading the
  `applyMiddleware` call shows exactly which wrappers apply and in which order.
- Middleware is trusted application code with the same authority as `run`. It
  can short-circuit execution or replace a result, and the engine still
  validates that result; it cannot skip input validation or `access`.
- A cache or idempotency middleware sees only the request context, so it must
  key results by capability, principal, and input itself; serving one caller's
  result to another remains the author's responsibility.
- Each wrapped invocation snapshots and freezes the input once more, adding
  bounded work proportional to the payload.
- `capabilityId` depends on where middleware is applied, so a library that
  wraps its own capabilities sees default IDs after a consumer remaps them.
- In-memory recipes are single-process; distributed rate limits, durable
  idempotency, and shared caches need an engine-owned port.
