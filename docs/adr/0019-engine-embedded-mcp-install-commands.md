# ADR 0019: Engine-embedded MCP install and uninstall commands

- Status: Accepted
- Date: 2026-08-02

## Context

ADR 0013 made `@invokta/installer` a binary-only standalone application, and
ADR 0017 added engine-scoped removal. Both flows reach a local engine through
`invokta-installer install --engine <project-directory>` and
`invokta-installer remove --engine <project-directory>`, and the generated
`mcp:install` and `mcp:uninstall` package scripts wrap those commands for the
author working inside the project checkout.

A distributed engine has no equivalent entry point. After an engine package is
installed from a registry, its consumer does not know the package's on-disk
directory, so the `--engine <project-directory>` contract is not reachable
without inspecting the package manager's layout. Engine authors need to ship
one memorable command with the package itself — for example
`support-engine install` — without duplicating the installer's reviewed client
configuration adapters, locking, state, rollback, and ownership rules, and
without expanding the standalone installer into a package loader.

## Decision

`@invokta/installer` adds one narrow embeddable subpath export,
`@invokta/installer/engine`, exposing `runEngineInstallerCli`. The root of the
package remains unexported, the package publishes no `main` or top-level
`types`, and the `invokta-installer` executable keeps the exact ADR 0013 and
ADR 0017 command surface. The installer remains the only writer of client
configuration; the embedded surface reuses the existing engine-scoped
interactive sessions and adds no new mutation path.

`runEngineInstallerCli` receives the embedding package's absolute root
directory and executable name and accepts exactly this argument surface:

```text
<engine-binary> install
<engine-binary> uninstall
<engine-binary> --help
```

`install` runs the ADR 0013 engine installation session and `uninstall` runs
the ADR 0017 engine-scoped removal session, both with the embedding package
root as the project directory. The closed `invokta.mcp.json` manifest contract,
current-user and no-follow path validation, TTY requirement, interactive
confirmation, diagnostics, and exit statuses `0`, `1`, `2`, and `130` are
unchanged. Any other argument vector is invalid usage. The embedded surface
performs no build, no package acquisition, no network access, and no engine
import or execution.

`create-invokta-engine` generates, for profiles that include MCP stdio, a
`src/bin.ts` composition root that resolves the package root from its own
module URL and delegates to `runEngineInstallerCli`, a package `bin` entry
named after the project, and a `files` list that packs `dist` and
`invokta.mcp.json`. `@invokta/installer` becomes a runtime dependency of those
generated projects. The build-first `mcp:install` and build-free
`mcp:uninstall` scripts remain the in-checkout author workflow.

The persisted launch descriptor still records the absolute Node executable and
absolute entry point (ADR 0013), so registration is only durable from a stable
package location, such as a global installation; an ephemeral extraction
directory invalidates the descriptor when it is pruned, and `status` reports
the missing entry point. Generated documentation states this constraint.

## Consequences

- A published engine registers and removes itself in local MCP clients with one
  shipped command, and every mutation continues through the installer's
  existing transactions, locks, rollback, and ownership fingerprints.
- `@invokta/installer/engine`, its argument surface, and its exit statuses
  become compatibility surfaces alongside the standalone command surface; the
  standalone binary contract is unchanged.
- The installer package is no longer import-free at its boundary; it remains
  framework-free, and the subpath export must not grow management, remote, or
  registry operations without a separate architectural decision.
- Generated engines carry the installer as a runtime dependency in exchange for
  a self-contained end-user installation flow.
