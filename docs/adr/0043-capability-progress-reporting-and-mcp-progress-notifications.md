# ADR 0043: Capability progress reporting and MCP progress notifications

- Status: Accepted
- Date: 2026-11-05

## Context

A long-running capability cannot tell its caller that it is still working.
`AE-LIMIT-01` excluded a progress API, `AE-LIMIT-05` excluded the related MCP
features, and `AE-CTX-01` closed `ExecutionContext` at five fields. The
repository's own image example declares capability timeouts of 150 to 180
seconds, and each of its capabilities waits on one opaque provider request for
most of that time.

MCP clients commonly enforce their own request timeouts. The official
TypeScript SDK client, for example, defaults to 60 seconds and resets that
timeout on progress only when the caller asks it to. A silent tool call is
indistinguishable from a hung one, so the client gives up before the engine's
own timeout is reached.

MCP `2025-11-25` defines `notifications/progress`. A requester opts in by
sending `_meta.progressToken`, a string or integer, with its request; the
receiver may then send notifications that carry the same token, a `progress`
value that MUST increase with every notification, and an optional `total` and
`message`. Both parties SHOULD rate-limit them.

The stateless HTTP adapter answered every request with one JSON body
(`enableJsonResponse: true`) and buffered the SDK response before writing it,
so no notification could reach an HTTP client before the result.

## Decision

### Core reporter

`ExecutionContext` gains one member, `reportProgress(report)`, where a
`ProgressReport` is `{ progress, total?, message? }`. `AE-CTX-01` is amended to
six fields. The member is a function bound to one invocation, not a registry,
metadata bag, or service locator.

- **Validation.** The report must be a non-proxy object whose three fields are
  read once. `progress` must be a finite number of at least zero; negative zero
  is delivered as `0`. `total`, when present, must be a finite positive number.
  `message`, when present, must be a string of at most 1,024 UTF-16 code units.
  `progress` is not required to stay at or below `total`, and `total` may
  change between reports, as the MCP schema allows.
- **Monotonicity.** A report whose `progress` is not greater than the last
  delivered value is dropped, not rejected. Rejecting would require either
  throwing into the capability or a result that every capability would have to
  handle for an advisory signal. A message-only update therefore needs a
  greater `progress` value.
- **Isolation.** `reportProgress` returns nothing and never throws. An invalid,
  non-increasing, or late report is dropped silently. The reporter calls the
  sink synchronously with a fresh, frozen snapshot, observes a returned promise
  without awaiting it, and contains a synchronous throw or a rejection, so a
  slow or failing sink cannot block the capability or change the invocation
  outcome. The first sink failure of an invocation sends one payload-free
  diagnostic, `Invocation progress callback failed.` with only the
  `requestId`, to the engine logger; delivery of later reports continues. A
  throwing or rejecting diagnostic logger is also contained. This matches the
  isolation of `onEvent` failures in ADR 0003.
- **Lifetime.** The reporter is active only while `run` is pending. The access
  rule receives a no-op reporter because execution has not been authorized
  yet; this mirrors the capability timeout, which also starts after
  authorization. Delivery stops for good once `run` settles or the invocation
  signal is aborted by the caller or the capability timeout, whichever happens
  first. Reports made after that point, including from work the capability left
  running, are dropped.
- **No sink.** Without a sink the context receives a shared no-op reporter, so
  reporting costs nothing and remains safe.

### Direct callers

`InvokeOptions.onProgress` is the sink for one invocation. It is read in the
same normalized options boundary as `requestId` and `source`: a throwing
accessor or a value that is not a function fails the invocation as
`EXECUTION_FAILED` with a generated request ID and the default `direct`
source, before input validation, after the ordered started and failed events.

`onProgress` is a per-invocation callback chosen by the caller, not a
cross-cutting engine hook. `onEvent` remains the only cross-cutting hook, and no
engine event is added: progress messages are capability-authored text and can
be frequent, while engine events stay payload-free lifecycle markers with a
fixed count per invocation. An observability host that needs progress can wrap
`invoke` and pass its own `onProgress`.

### MCP

When a `tools/call` request carries `params._meta.progressToken` as a string of
at most 256 UTF-16 code units or a safe integer, the protocol server forwards
each delivered report through the SDK request handler's `extra.sendNotification`
as `notifications/progress` with that exact token, including `0` and `""`.
Without a token, or with a longer string token, no progress notification is
sent and the call is otherwise unchanged. Each notification repeats the token,
so the length bound prevents a client from turning a large token into large
repeated output.

The adapter sends at most one notification per 100 milliseconds for one
request. Reports inside the interval coalesce to the latest one, which is sent
when the interval ends if the call is still active; a coalesced report still
pending when the call settles is dropped. Because the core delivers only
increasing values, the coalesced stream also increases. Notification send
failures, including those for a request the client already cancelled, are
contained and never change the tool result.

Over stdio, notifications share the protocol stream with responses and are
written before the result of the same call.

Over stateless HTTP, every request still answers with one JSON body except a
single `tools/call` request that carries a usable progress token. That POST
alone receives a `text/event-stream` response: the SDK transport for that
request is created with `enableJsonResponse: false`, the stream carries only
the progress notifications for that request followed by its JSON-RPC response,
and it closes after the response. The adapter relays the stream event by event
and honors socket backpressure instead of buffering the whole body. The SDK
sends an SSE keep-alive comment every 15 seconds while the stream is open.

This fits the stateless profile of ADR 0007 because the stream belongs to one
request and nothing survives it: there is no session ID, event store, event ID,
priming event, resumption, standalone `GET` stream, or server-to-client
request. ADR 0006 excluded the SDK's server-to-client SSE behavior; that
exclusion remains for every stream except the response stream of a
progress-token tool call. Every request bound is applied before the response mode is chosen and is
unchanged: canonical target, method, `Host`, `Origin`, authentication,
`Accept`, `Content-Type`, body size, strict UTF-8, and one JSON-RPC message.
A client disconnect during the stream aborts the invocation, and server close
aborts it and closes the connection, as before.

### CLI

The CLI keeps stdout for the requested result only. In the default `json`
format it passes no sink, so stdout and stderr are byte-for-byte unchanged for
agents and scripts. In the `human` format, which a trusted composition root
selects for a person at a terminal, each delivered report becomes one stderr
line, `progress <progress>[/<total>][: <message>]`. The write is not awaited,
its failure is contained like every other diagnostic write, and Unicode control,
format, line-separator, and paragraph-separator characters in the message are
escaped as `\uXXXX` or `\u{X}`.

### Out of scope

MCP Tasks remain out of scope. A task turns a request into a durable,
pollable unit with its own identity, status, time-to-live, result retrieval,
and cancellation through `tasks/*` requests. That requires a task store and
identity that survive the originating request, which contradicts the stateless
HTTP profile of ADR 0007 and the absence of jobs, queues, and durable execution
in `AE-LIMIT-01`. Progress addresses liveness within one request without any
such state.

Streaming partial results, resumption, persisted or replayable progress, MCP
logging notifications, progress for requests other than `tools/call`, and a
progress-specific engine event are not provided.

## Consequences

- A capability can keep a cooperating client waiting for a long request through
  every channel without knowing which channel invoked it.
- `ExecutionContext` gains a required member. This is a breaking type change
  for code that constructs an `ExecutionContext` by hand, for example a unit
  test that calls `run` directly; such code adds
  `reportProgress: () => undefined`. Capabilities, access rules, adapters, and
  callers of `invoke` are source compatible.
- Progress is advisory. Reports may be dropped when invalid, non-increasing,
  coalesced, late, or undeliverable, and no delivery guarantee is offered.
- An HTTP client that sends a progress token now receives an SSE response. The
  Streamable HTTP transport already requires clients to accept both
  `application/json` and `text/event-stream`, and the adapter already rejected
  requests that do not. A client that sends no token observes no change.
- A reverse proxy in front of the HTTP adapter must not buffer
  `text/event-stream` responses for progress to arrive before the result. The
  SDK sends `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform`.
- A client must still opt in to longer waits; for example the official
  TypeScript SDK client needs `resetTimeoutOnProgress` and, when wanted, a
  `maxTotalTimeout`.

## Decision evidence

- [MCP 2025-11-25 progress utility](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)
- [MCP 2025-11-25 Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- [MCP 2025-11-25 tasks utility](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- `packages/core/test/progress.test.ts`, `packages/mcp/test/progress.test.ts`,
  `packages/cli/test/progress.test.ts`, and
  `examples/image-engine/test/progress.test.ts`
