# ADR 0004: ESM monorepo and package boundaries

- Status: Accepted
- Date: 2026-07-27

## Context

The runtime, transport adapters, development tools, and end-user configuration
tools have different dependencies and authority. They must evolve in one
repository without leaking transport or operational concerns into the kernel.

## Decision

Invokta is a private Yarn workspace that publishes six native ESM packages:

| Package | Role |
| --- | --- |
| `@invokta/core` | Framework kernel and capability composition |
| `@invokta/cli` | CLI runtime adapter |
| `@invokta/mcp` | MCP runtime adapter |
| `@invokta/tooling` | Development-time composition build gate |
| `@invokta/installer` | End-user MCP client configurator |
| `@invokta/deploy` | Development-time HTTP engine generator and probe |

Published packages declare `"type": "module"` and expose only ESM entry
points. The project does not maintain a parallel CommonJS build.

Dependency direction is explicit:

- CLI and MCP may depend on the core and execute capabilities only through its
  public `engine.invoke` path.
- Tooling may depend on the core's public composition API but contributes no
  runtime behavior.
- Installer and deploy remain standalone applications and do not depend on the
  runtime or on each other.
- The core never depends on an adapter or supporting application.

The root workspace owns the lockfile, shared configuration, and quality gates.
Package-specific dependencies and public types remain inside their owning
package.

## Consequences

- Transport and application dependencies cannot enter the kernel accidentally.
- Every published artifact has a separate public surface and release smoke test.
- CommonJS consumers must use ESM interoperability.
- Adding a package or reversing a dependency edge requires a new architectural
  decision.
