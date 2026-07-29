# ADR 0010: Standalone local capability MCP installer

- Status: Accepted
- Date: 2026-07-28

## Context

Configuring supported AI harnesses to connect to an engine's MCP server requires
local discovery and controlled edits to third-party user configuration. That is
neither capability execution nor a development-time composition check.

## Decision

ADR 0013 extends this decision with explicit project-local and direct remote
sources, persisted launch descriptors, lifecycle commands, and two additional
client targets. Its source and management rules supersede the bundled-registry-
only boundary below; the package isolation and no-execution/no-network boundary
remain in force.

`@invokta/installer` is a standalone native ESM end-user application exposing
`invokta-installer`. It owns a bundled, immutable capability registry, finite
detection of supported harnesses, format-preserving configuration adapters,
ownership state, preflight, locking, rollback, diagnostics, and its interactive
terminal experience.

The installer has no public programmatic mutation API and no dependency on the
runtime, tooling, or deploy packages. Its registry contains reviewed MCP launch
or connection descriptors; it is configuration data, not a plugin system.

The installer performs no remote discovery, package loading, reflection, shell
execution, package-manager invocation, capability execution, or network
connection. It writes a supported client configuration only after preflight and
explicit user confirmation. A configured harness later reaches capabilities
through `@invokta/mcp` and the single `engine.invoke` path; the installer is not
part of that call graph.

Installer error and exit codes remain application contracts and do not extend
`EngineError`. Diagnostics must not expose credentials or configuration values.

## Consequences

- Users receive one focused interface for supported MCP client configuration.
- Local configuration authority requires fail-closed validation, atomic writes,
  explicit ownership, bounded locks, and rollback.
- Harness formats and the bundled registry are compatibility surfaces owned by
  the installer package.
