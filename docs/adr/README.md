# Architecture Decision Records

This directory contains Invokta's durable architectural decisions. ADRs record
the context, current boundary, and consequences; delivery chronology and
implementation specifications are intentionally excluded. Exact public behavior
is defined by the architecture, guides, package APIs, and acceptance tests.

| ADR | Decision | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-hexagonal-kernel-without-container-or-runtime-modules.md) | Hexagonal kernel without a container or runtime modules | Accepted | 2026-07-27 |
| [0002](0002-standard-schema-and-standard-json-schema-contracts.md) | Standard Schema and Standard JSON Schema as schema contracts | Accepted | 2026-07-27 |
| [0003](0003-single-pipeline-structured-errors-and-observable-events.md) | Single pipeline, structured errors, and observable events | Accepted | 2026-07-27 |
| [0004](0004-esm-monorepo-and-package-boundaries.md) | ESM monorepo and package boundaries | Accepted | 2026-07-27 |
| [0005](0005-cli-always-executes-through-invoke.md) | CLI always executes capabilities through `invoke` | Accepted | 2026-07-27 |
| [0006](0006-isolated-official-mcp-sdk-and-protocol-2025-11-25.md) | Isolated official MCP SDK and protocol `2025-11-25` | Accepted | 2026-07-27 |
| [0007](0007-stateless-http-with-pluggable-authn-and-core-authz.md) | Stateless HTTP, pluggable authentication, and core authorization | Accepted | 2026-07-27 |
| [0008](0008-tdd-and-commits-scoped-to-each-deliverable.md) | TDD and commits scoped to each deliverable | Accepted | 2026-07-27 |
| [0009](0009-capability-composition-and-dev-tooling.md) | Capability composition and development tooling | Accepted | 2026-07-28 |
| [0010](0010-standalone-local-capability-mcp-installer.md) | Standalone local capability MCP installer | Accepted | 2026-07-28 |
| [0011](0011-http-engine-deploy-toolkit.md) | HTTP engine deployment toolkit | Accepted | 2026-07-28 |
| [0012](0012-standalone-invokta-engine-creator.md) | Standalone Invokta engine creator | Accepted | 2026-07-29 |
| [0013](0013-action-engine-mcp-installation-and-management.md) | Action Engine MCP installation and management | Accepted | 2026-07-29 |
| [0014](0014-standalone-capability-project-creators.md) | Standalone capability project creators | Accepted | 2026-07-29 |
| [0015](0015-generated-agent-instruction-aliases.md) | Generated agent instruction aliases | Accepted | 2026-07-30 |
| [0016](0016-generated-invokta-development-skills.md) | Generated Invokta development skills | Accepted | 2026-07-30 |
| [0017](0017-engine-scoped-mcp-uninstall.md) | Engine-scoped MCP uninstall | Accepted | 2026-07-30 |
| [0018](0018-interactive-engine-creator-profiles.md) | Interactive engine creator profiles | Accepted | 2026-07-30 |
| [0019](0019-engine-embedded-mcp-install-commands.md) | Engine-embedded MCP install and uninstall commands | Accepted | 2026-08-02 |
| [0020](0020-github-example-import-for-engine-creator.md) | GitHub example import for the engine creator | Accepted | 2026-08-06 |
| [0021](0021-engine-devtools-dev-server.md) | Engine devtools dev server | Accepted | 2026-08-05 |
| [0022](0022-mcp-installation-inspection-and-homologation.md) | MCP installation inspection and homologation | Accepted | 2026-08-06 |
| [0023](0023-ephemeral-oauth-for-installed-mcp-inspection.md) | Ephemeral OAuth for installed MCP inspection | Accepted | 2026-08-06 |
| [0024](0024-production-mcp-oauth-integration-boundary.md) | Production MCP OAuth integration boundary | Accepted | 2026-08-10 |
| [0025](0025-portable-mcp-tool-names.md) | Portable MCP tool names | Accepted | 2026-08-11 |
| [0026](0026-generated-engine-mcp-conformance-gate.md) | Generated engine MCP conformance gate | Accepted | 2026-08-11 |
| [0027](0027-windows-installer-ownership-identity.md) | Windows installer ownership identity | Accepted | 2026-08-13 |
| [0028](0028-adapter-emulation-in-engine-devtools.md) | Adapter emulation in the engine devtools | Accepted | 2026-08-13 |
| [0029](0029-selectable-http-authentication-in-devtools.md) | Selectable HTTP authentication in the engine devtools | Accepted | 2026-08-13 |
| [0030](0030-project-entry-points-in-devtools-emulation.md) | Project entry points in devtools emulation | Accepted | 2026-08-13 |
| [0031](0031-oauth-discovery-inspection-and-advertised-servers.md) | OAuth discovery inspection and advertised authorization servers | Accepted | 2026-08-13 |
| [0032](0032-cli-installation-inspection-and-homologation.md) | CLI installation inspection and homologation | Accepted | 2026-08-15 |
| [0033](0033-workbench-launcher-and-selection.md) | Workbench launcher and workbench selection | Accepted | 2026-08-15 |
| [0034](0034-harness-config-variants-and-vscode-remote-user-scope.md) | Harness configuration variants and VS Code remote user scope | Accepted | 2026-08-22 |
