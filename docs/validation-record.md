# Validation record

- Last reviewed: 2026-08-22
- Public API changes: standalone atomic capability and capability-library
  creators accepted in ADR 0014; engine and capability-library agent
  instruction aliases accepted in ADR 0015; generated development skills
  accepted in ADR 0016; engine-scoped MCP uninstall accepted in ADR 0017;
  interactive engine creator profiles and the public deploy scaffold planner
  accepted in ADR 0018; GitHub example import for `create-invokta-engine`
  accepted in ADR 0020; the `@invokta/devtools` dev server and doctor accepted
  in ADR 0021; MCP installation inspection and homologation accepted in
  ADR 0022; ephemeral OAuth for installed MCP inspection accepted in ADR 0023;
  the production MCP OAuth integration boundary accepted in ADR 0024; portable
  MCP tool names accepted in ADR 0025; generated engine MCP conformance accepted
  in ADR 0026; Windows installer ownership identity accepted in ADR 0027;
  devtools adapter emulation accepted in ADR 0028; selectable HTTP
  authentication accepted in ADR 0029; project entry points accepted in ADR
  0030; advertised authorization servers and OAuth discovery inspection
  accepted in ADR 0031; CLI installation inspection and homologation
  accepted in ADR 0032; and the workbench launcher with workbench selection
  accepted in ADR 0033; and typed connector definitions accepted in ADR 0035.
- Architectural conventions: ADR 0034 defines engine-owned outbound connectors;
  ADR 0035 adds their optional typed core authoring definition without changing
  capability contracts, the error-code taxonomy, or the execution path.

## Reuse evidence

The repository exercises Action Engines across independent domains and
execution channels:

| Evidence | Domain behavior | Channels or consumers |
| --- | --- | --- |
| `examples/hello-engine` | Minimal onboarding action | Direct, CLI, MCP stdio, MCP HTTP |
| `examples/support-engine` | Ticket classification with domain authorization | Direct, CLI, MCP stdio, MCP HTTP, independent MCP harness |
| `examples/crawl-engine` | Firecrawl outbound connector behind `WebCrawler` | Direct, CLI, MCP stdio, MCP HTTP |
| `examples/image-engine` | Replaceable multi-provider image connectors | Direct, CLI, MCP stdio, MCP HTTP |
| `examples/observability-engine` | Bounded Sentry, Datadog, and New Relic connectors | Direct, CLI, MCP stdio, MCP HTTP |
| `examples/obsidian-context-engine` | Bounded read-only filesystem connector | Direct, CLI, MCP stdio, MCP HTTP |
| `examples/composed-engine` | Local, atomic, and library capability composition | Direct, CLI, MCP stdio, MCP HTTP, tooling build gate |
| `examples/agent-session-engine` | Durable task and handoff state through a filesystem connector | Direct, CLI, MCP stdio, MCP HTTP, harness hooks |

The support harness uses the official MCP client and imports no Invokta runtime
package. Tool discovery and invocation therefore demonstrate that an independent
consumer can use the protocol surface without coupling to engine code.

## Current delivery gates

- `yarn run check` passes typecheck, lint, formatting, 2,996 tests with one
  intentional skip, V8 coverage, and the full TypeScript build. Coverage is
  78.55% statements, 74.00% branches, 82.85% functions, and 80.06% lines.
- `yarn release:verify` passes clean tarball inspection, isolated ESM imports,
  dependency boundaries, all four packed engine profiles, the authenticated MCP
  HTTP exchange, and the remaining creator and installer smoke tests.
- `yarn validate` in `apps/docs` passes route and link tests, Astro diagnostics,
  and the production site build.
- `yarn audit` reports zero vulnerabilities across 307 audited packages.

## Boundaries exercised

- Input and output use the same Standard Schema and Standard JSON Schema
  declarations across direct, CLI, and MCP execution.
- All inbound adapters converge on `engine.invoke`; none duplicates validation,
  authorization, execution, or output validation.
- MCP stdio keeps stdout protocol-only and propagates cancellation within one
  connection lifetime.
- MCP HTTP authenticates at the request boundary, authorizes in the core, and
  creates no cross-request session state.
- Capability composition preserves explicit imports and fails deterministically
  on effective-ID collisions.
- Network- and filesystem-backed examples construct outbound connectors
  explicitly through `defineConnector`, reject invalid configuration before
  I/O, inject only engine-owned ports into capabilities, propagate cancellation,
  translate external values, bound provider and filesystem work, and keep
  credentials and raw external payloads out of public errors and internal
  causes.
- Core connector tests prove inert definition, synchronous Standard Schema
  transformation, frozen lossless configuration, opaque dependency identity,
  frozen named-port containers, sanitized configuration failures, and explicit
  injection into capabilities. The crawl composition root exercises the same
  public helper without publishing connector metadata through its engine.
- The creators, installer, and deploy packages remain outside the capability
  call graph and exercise only their documented project creation, local
  configuration, and generation authority. Injected fetch harnesses cover
  `create-invokta-engine --example` resolution, download, package-name rewrite,
  cancellation before archive download, and mutual exclusion with `--profile`
  without live network access.
- Generated engine `AGENTS.md` and `develop-invokta-project` guidance distinguish
  capabilities from outbound connectors and preserve explicit, port-only
  connector composition without adding a generated connector to the minimal
  deterministic starter.
- Packed creator smoke tests generate the exact `complete`, `mcp-stdio`,
  `mcp-http`, and `cli` file sets from release tarballs. Every profile installs,
  type-checks, tests, builds, and invokes the shared capability directly and
  through each selected adapter. Profiles containing HTTP prove byte identity
  with the immutable `@invokta/deploy/scaffold` plan, refusal by the untouched
  authentication stub through one sanitized, stack-free diagnostic, and an
  authenticated official MCP client exchange after replacing only that stub.
  The complete profile also verifies its exact build-first `mcp:install` and
  build-free `mcp:uninstall` paths. Tests verify
  that generated engine and capability-library
  projects contain a regular `AGENTS.md`, a symbolic-link `CLAUDE.md`, and the
  exact relative target `AGENTS.md`. All three generated project types contain
  a valid `develop-invokta-project` skill with tailored contract and composition
  guidance and deterministic UI metadata. Packed tests also build generated
  atomic and library packages, compose their public root exports through
  `@invokta/core`, and invoke them through `engine.invoke`. Installer tests
  cover local manifests, remote descriptors, multi-client transactions,
  lifecycle management, engine-scoped preflight and removal, eleven target
  adapters, and forbidden process, network, and write sentinels.

## Ownership conclusions

Invokta supplies stable contracts, a small execution kernel, inbound adapters,
explicit composition, and bounded supporting tools. Custom engines continue to own model
and data providers, prompts, domain policies, evaluation, observability,
dependency lifecycle, and production risk controls.

The examples validate framework reuse; they do not claim provider quality,
production identity assurance, evaluation coverage, cost control, incident
readiness, privacy compliance, or safety for a particular domain. Those claims
require evidence from the engine and its deployment environment.
