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

Failures will be `EngineError` instances with one of seven stable codes:
`CAPABILITY_NOT_FOUND`, `INPUT_INVALID`, `UNAUTHENTICATED`, `FORBIDDEN`,
`OUTPUT_INVALID`, `CANCELLED`, or `EXECUTION_FAILED`. `publicDetails` and `cause`
will be optional; only `publicDetails` may be serialized by default. Unknown
exceptions will be normalized as `EXECUTION_FAILED`.

The only cross-cutting hook will be `onEvent`. It will receive only
`invocation.started`, `invocation.completed`, and `invocation.failed`, with the
minimum fields defined by the public contract. Business payloads, tokens, and
credentials will not be part of these events. The custom engine may connect the
hook to logs, metrics, or tracing.

## Consequences

- All transports share the same execution semantics.
- Error codes make integrations stable without depending on human-readable
  messages.
- Logs, metrics, and tracing can observe events without entering the domain.
- The pipeline and the order of its stages become part of the contract and
  require contract tests.
- The kernel does not provide domain events or delivery guarantees.
