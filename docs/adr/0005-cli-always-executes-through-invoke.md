# ADR 0005: CLI always executes capabilities through `invoke`

- Status: Accepted
- Date: 2026-07-27

## Context

A CLI that calls handlers directly creates a second execution path and can bypass
validation, authorization, events, and error normalization. This would make a
capability's behavior depend on how it was called.

## Decision

Every `@ai-engine/cli` command that executes a capability must construct
the invocation and call the public `invoke` API from `@ai-engine/core`. The CLI
must not import handlers to execute them, reproduce the pipeline, or apply
business rules before or after `invoke`.

The CLI will be responsible only for:

- parsing arguments and standard input;
- selecting the capability and constructing its transport context;
- calling `invoke` once;
- formatting the result or structured error;
- choosing the exit code from the documented error category or code.

Help, version, and purely syntactic errors from the command line itself are not
engine capabilities and may be handled locally. As soon as a capability is
selected, its only execution path will be `invoke`.

## Consequences

- CLI, MCP, HTTP, and programmatic use exercise the same guarantees.
- CLI tests can focus on parsing, formatting, and integration with `invoke`.
- CLI-exclusive features must not exist as shortcuts to handlers; they must be
  modeled as capabilities when they belong to the engine.
- The mapping of errors to exit codes must be stable and documented.
