# ADR 0005: CLI always executes capabilities through `invoke`

- Status: Accepted
- Date: 2026-07-27

## Context

A CLI that calls handlers directly creates a second execution path and can bypass
validation, authorization, events, and error normalization. This would make a
capability's behavior depend on how it was called.

## Decision

Every `@invokta/cli` command that executes a capability must construct
the invocation and call the public `invoke` API from `@invokta/core`. The CLI
must not import handlers to execute them, reproduce the pipeline, or apply
business rules before or after `invoke`.

The CLI will be responsible only for:

- parsing arguments and standard input;
- selecting the capability and constructing its transport context;
- calling `invoke` once;
- formatting the result or structured error;
- choosing the exit code from the documented error category or code.

`runCli` requires the composition root to provide `principal`, including an
explicit `null` for anonymous local execution. It returns the exit code and never
terminates the process or mutates `process.exitCode`; the composition root may
assign the returned value. It accepts an optional host `AbortSignal` and passes it
unchanged to `invoke`.

JSON is the default and canonical output. A trusted `format: "human"` option may
select deterministic, pretty-printed JSON of the same value; it does not perform
semantic rendering. Errors on `stderr` are compact JSON and contain only a code,
message, and optional `publicDetails`. The adapter never adds a stack, cause, raw
input, or principal. Engine authors remain responsible for ensuring that the
explicitly public `message` and `publicDetails` fields contain no secrets.

`run` accepts exactly one input source: `--input <json>` or `--stdin`. Missing,
duplicate, combined, trailing, and unknown arguments produce exit code `2`
without invoking the engine. Version 0.1 reads stdin without a framework-owned
size limit; hosts may inject a bounded reader when local input is not trusted.
The default reader incrementally decodes byte chunks with fatal UTF-8 validation,
while preserving multibyte code points split across byte chunks and surrogate
pairs split across string chunks. Malformed UTF-8 is invalid usage, returns exit
code `2`, and cannot reach `invoke`.

Host-provided stdout and stderr writers may complete synchronously or return a
promise. `runCli` awaits their completion. A throwing or rejected stdout write is
a sanitized execution failure with exit code `1`. A throwing or rejected stderr
write is contained so the diagnostic destination cannot replace the command's
numeric outcome or create an unhandled rejection.

Help, version, and purely syntactic errors from the command line itself are not
engine capabilities and may be handled locally. As soon as a capability is
selected, its only execution path will be `invoke`.

## Consequences

- CLI, MCP, HTTP, and programmatic use exercise the same guarantees.
- CLI tests can focus on parsing, formatting, and integration with `invoke`.
- CLI-exclusive features must not exist as shortcuts to handlers; they must be
  modeled as capabilities when they belong to the engine.
- The mapping of errors to exit codes must be stable and documented.
- Process termination remains an explicit responsibility of each executable's
  composition root.
- Returning from `runCli` confirms completion of every successful asynchronous
  output write; a failed diagnostic write remains intentionally unobservable to
  its caller beyond the original numeric result.
