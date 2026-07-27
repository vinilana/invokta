# ADR 0004: Monorepo with three ESM packages

- Status: Accepted
- Date: 2026-07-27

## Context

The project has a reusable kernel and two distributable integrations, CLI and
MCP. They must evolve together without merging their dependencies or publishing
multiple variants of JavaScript modules.

## Decision

The repository will be a monorepo with exactly three product packages:

| Path | Published name | Responsibility |
| --- | --- | --- |
| `packages/core` | `@ai-engine/core` | Capabilities, engine runtime, contracts, errors, and events |
| `packages/cli` | `@ai-engine/cli` | Composition and command-line interface |
| `packages/mcp` | `@ai-engine/mcp` | Model Context Protocol adapter |

All three packages will be native ESM, declare `"type": "module"`, and publish
only ESM entry points through `exports` maps. There will be no parallel CommonJS
build or use of `require` in the published API.

The root package will be private and coordinate the workspace, lockfile, and
quality commands. `@ai-engine/cli` and `@ai-engine/mcp` may depend on
`@ai-engine/core`; the core will not depend on them, and CLI and MCP will not
depend on each other. Internal configurations and tools do not constitute product
packages.

## Consequences

- Each artifact maintains its own public surface and dependencies.
- Contract changes can be verified across all consumers in the same workspace.
- CommonJS consumers will need to use ESM interoperability; there will be no CJS
  artifact maintained by the project.
- The dependency graph prevents transport details from entering the kernel.
- Publishing and versioning must respect compatibility among the three packages.
