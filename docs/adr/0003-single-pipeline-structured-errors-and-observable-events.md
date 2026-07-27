# ADR 0003: Single pipeline, structured errors, and observable events

- Status: Accepted
- Date: 2026-07-27

## Context

CLI, MCP, HTTP, and programmatic calls must not diverge in validation,
authorization, execution, or failure handling. It is also necessary to observe an
invocation without coupling the core to logs, metrics, or a specific broker.

## Decision

Every capability execution will pass through a single core pipeline, triggered by
`invoke`. The normative order will be:

1. generate or accept `requestId` and resolve the capability;
2. validate and transform the input;
3. create `ExecutionContext` and apply the `access` rule;
4. combine the received signal with the timeout and execute `run`;
5. validate and transform the output;
6. emit the success or failure event and return or throw.

An adapter may decode a request before the pipeline and encode the response after
it, but it must not skip or reimplement stages. Version 0.1 will have no
before/after/onError policies, queue, concurrency, retry, or lifecycle.

After a successful input transformation and lossless-JSON check, the core will
capture a deep request-owned snapshot. Authorization receives a separate deep
clone of that snapshot. The execution handler receives the unmodified execution
snapshot, not the authorization clone or the validator-owned value. This makes
the authorization decision and execution deterministic even when a validator
returns caller-owned data or an access rule mutates its arguments.

Failures will be `EngineError` instances with one of seven stable codes:
`CAPABILITY_NOT_FOUND`, `INPUT_INVALID`, `UNAUTHENTICATED`, `FORBIDDEN`,
`OUTPUT_INVALID`, `CANCELLED`, or `EXECUTION_FAILED`. `publicDetails` and `cause`
will be optional; only `publicDetails` may be serialized by default. Unknown
exceptions will be normalized as `EXECUTION_FAILED`. Runtime-mutated,
proxy-wrapped, or accessor-backed `EngineError` values whose own `code` and
`message` data properties cannot establish a stable public error will be treated
as unknown without invoking the unsafe property.

Invocation metadata extraction is inside the same normalized boundary. If
reading `requestId` or `source` from the options object throws, partially read
metadata will be discarded. The invocation will use a generated request ID and
the default `direct` source to emit the ordered started and failed events, then
reject with `EXECUTION_FAILED`; the original property failure remains internal.

The only cross-cutting hook will be `onEvent`. It will receive only
`invocation.started`, `invocation.completed`, and `invocation.failed`, with the
minimum fields defined by the public contract. Business payloads, tokens, and
credentials will not be part of these events. The custom engine may connect the
hook to logs, metrics, or tracing. A hook failure will not change the invocation
result; the runtime may report it through the configured logger without business
payloads or credentials. Hook invocation will be synchronous and ordered as a
started event followed by exactly one completed or failed event. A promise
returned by a hook will be observed for rejection but will not be awaited, so a
pending observability backend cannot delay capability execution, result delivery,
or error delivery. Version 0.1 provides no event delivery-completion guarantee.
An asynchronous rejection from the diagnostic logger will also be observed and
contained. The capability timeout ends after successful output validation,
before the completed hook is invoked.

An optional capability `timeoutMs` will be a positive integer in the inclusive
range `1..2_147_483_647`. `createEngine` will reject zero, negative and
fractional values, `NaN`, infinities, and values above that range synchronously
with `TypeError`. This construction-time boundary matches the maximum portable
delay accepted by the Node.js timer used by the supported runtime and prevents
timer overflow from being coerced into an immediate timeout or emitting a host
warning. Both inclusive endpoints remain valid configuration.
The capability definition will be captured with one read of each top-level field
before the timeout is validated or any contract is derived. Validation,
description, and execution will therefore use the same captured timeout even if
the source definition uses a changing accessor.

## Consequences

- All transports share the same execution semantics.
- Error codes make integrations stable without depending on human-readable
  messages.
- Logs, metrics, and tracing can observe events without entering the domain.
- Observability integrations that require delivery guarantees or backpressure
  must provide them outside this best-effort hook.
- The pipeline and the order of its stages become part of the contract and
  require contract tests.
- Input snapshotting adds bounded work proportional to the validated payload but
  prevents concurrent caller or authorization mutations from crossing stages.
- Invalid timeout configuration fails before the engine can invoke a capability
  or schedule a timer; the maximum valid delay retains its full duration.
- The kernel does not provide domain events or delivery guarantees.
