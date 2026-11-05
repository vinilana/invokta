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
order. Each wrapped capability is a frozen copy that replaces only `run`. It
keeps by identity every own property of the source, whether enumerable or not
and whether string or symbol keyed. It also keeps the contract fields that
`createEngine` and the contracts built on it read through the prototype chain:
`title`, `description`, `input`, `output`, `access`, `timeoutMs`,
`annotations`, `errors`, `deprecated`, and `run`. Inherited contract fields
become own fields of the copy, and each field keeps its enumerability. No other
inherited member is invoked or copied, so a class-based capability's
`constructor`, methods, lazy getters, and inherited symbols stay untouched,
just as `createEngine` leaves them. It performs no I/O and calls no middleware,
access rule, or handler.
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
- the capability timeout and caller cancellation cover the whole chain, and no
  layer can outlive the invocation (see `next()` below);
- the outermost middleware's result is validated and transformed against the
  output schema, whether it came from `run` or was produced by a middleware;
- an error thrown or rejected by a middleware is normalized exactly like an
  error from `run`, so a stable `EngineError` is preserved and any other value
  becomes `EXECUTION_FAILED` with an internal cause;
- a `CapabilityError` that `run` raises keeps its identity through the chain
  and resolves against the capability's declared `errors` (ADR 0045), and one
  that a middleware raises is treated the same way. It is published as
  `DOMAIN_ERROR` only when the wrapped capability declares its code and its
  details are valid; otherwise it fails as `EXECUTION_FAILED`; and
- events, CLI, MCP, and every other adapter observe one ordinary invocation.

`capabilityId` is the capability's key in the map passed to `applyMiddleware`.
The engine does not pass the ID to `run`, and this decision does not change the
handler signature. Applying middleware to the final composed map therefore
observes effective engine IDs; middleware applied inside a library or atomic
export observes that package's default ID.

Order is deterministic: the first listed middleware is outermost and the
handler is innermost. Applying middleware to a map that already contains
wrapped capabilities places the new chain outside the earlier one.

`next()` takes no arguments, so a middleware cannot pass a different input or
context object to the next layer. It resolves to the next layer's unvalidated
result and may be called at most once while its middleware is pending. A
repeated call, including a re-entrant call from the synchronous start of the
next layer, or a call after the middleware settled, rejects with `TypeError`
without starting the next layer; if that rejection propagates, the invocation
fails as `EXECUTION_FAILED`. A call after the invocation signal aborted rejects with the
signal reason without starting the next layer, matching the engine's check
before `run`. Like the engine, the chain reads the signal through the platform
accessors, so a wrapped `run` called outside the engine requires a platform
`AbortSignal`. Rejections from `next()` promises that a middleware never awaits
are contained. Retries therefore remain outside the framework, as AE-LIMIT-01
requires.

A started layer cannot detach from the invocation. When a middleware settles,
its result or error is held until the layer it started with `next()` has
settled, and the outcome of a layer it did not await is ignored. Every
middleware, and `run` itself, therefore settles before the outermost layer
returns. The invocation cannot complete while part of the chain is still
running, so a handler cannot start after completion with a signal that never
aborts. A middleware that starts `next()` and returns early, races it against a
timer, or revalidates in the background still holds the invocation until that
work settles. The capability timeout and caller cancellation then bound it like
any other part of the chain. When they fire, the engine settles the invocation
as `CANCELLED` and no further layer starts, but a handler that is already
running stops only when it observes the signal, as without middleware.

Middleware receives the input as a deep-frozen snapshot that `run` never sees,
so middleware cannot mutate what execution observes, in the same way
AE-SCHEMA-02 isolates `access`. `run` still receives the unmodified execution
snapshot. The snapshot is taken lazily, with `structuredClone` and a deep
freeze, the first time any middleware of the invocation reads `input`. Every
layer and every nested application of the same invocation share it, and the
lossless JSON check the engine already performed is not repeated. A middleware
that never reads `input` costs no copy. Because `run` owns its copy, a snapshot
first read after `next()` reflects any change `run` made to its input, so a
middleware that needs the value as validated reads it before calling `next()`.
A wrapped `run` called directly outside the engine accepts the same inputs as
the original until a middleware reads `input`, which then requires a
structured-cloneable value. The snapshot is memoized per `run` arguments
object, so such a direct caller passes a fresh arguments object to each call.

The context object is the engine's frozen `ExecutionContext`, shared by
identity with `run` so that fields other contracts add keep working. Its
`principal` is the same identity snapshot `run` receives and is not frozen.
Middleware must not mutate it: the access decision has already been made, and
identity decisions belong in `access`. The framework documents this obligation
for trusted middleware rather than freezing the principal, which would change
what `run` may do, or cloning it, which would break context identity.

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
construction. `createEngine` semantics, the six pipeline stages, the error
taxonomy, `ExecutionContext`, and the single `onEvent` hook are unchanged.

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
- An invocation whose middleware reads `input` performs one more clone and
  freeze of the payload, however many layers and nested applications read it;
  middleware that never reads `input` adds no payload-proportional work.
- Middleware cannot hide latency by detaching the rest of the chain;
  stale-while-revalidate and background refresh need an engine-owned queue or
  port outside the invocation.
- `context.principal` is mutable shared state between middleware and `run`;
  safety relies on middleware honoring the documented obligation.
- `capabilityId` depends on where middleware is applied, so a library that
  wraps its own capabilities sees default IDs after a consumer remaps them.
- In-memory recipes are single-process; distributed rate limits, durable
  idempotency, and shared caches need an engine-owned port.
