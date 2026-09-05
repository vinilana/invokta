# Validation record

- Last reviewed: 2026-09-05
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
  accepted in ADR 0033; harness configuration variants and VS Code remote user
  scope accepted in ADR 0034; example archive path and subtree validation
  accepted in ADR 0035; engine-owned outbound connectors accepted in ADR 0036;
  typed connector definitions accepted in ADR 0037; guided OpenAPI
  capability import accepted in ADR 0038; and the configurable MCP HTTP
  mount path accepted in ADR 0039; installer support for those mounted URLs
  accepted in ADR 0040; multiple managed installation removal accepted in
  ADR 0041.
- Architectural conventions: ADR 0036 defines engine-owned outbound connectors;
  ADR 0037 adds their optional typed core authoring definition without changing
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

- `yarn run check` on Node.js 24.20.0 and Yarn 1.22.22 passes typecheck, lint,
  formatting, 3,190 tests with one intentional skip, V8 coverage, and the full
  TypeScript build, followed by 19 example gates. Coverage is 79% statements,
  74.4% branches, 83.52% functions, and 80.71% lines.
- `yarn release:verify` passes for 0.9.0: metadata alignment and
  clean tarball inspection for all 10 public packages, isolated ESM imports,
  all four packed engine profiles, authenticated MCP HTTP exchange, DevTools
  doctor checks, and the
  atomic and capability-library creator smoke tests.
- `yarn validate` in `apps/docs` passes 15 route and link contract tests, zero
  Astro diagnostics, and the 49-page production site build.
- The 0.9.0 preparation audits report zero vulnerabilities across 307 audited
  root packages and 537 documentation packages.

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
  v1 validation and transformation, object-rooted frozen lossless configuration,
  opaque dependency identity, frozen named-port containers, sanitized
  configuration failures, and explicit injection into capabilities. The crawl
  composition root exercises the same public helper without publishing connector
  metadata through its engine. Provider examples cancel declared-oversized
  response bodies before returning their bounded failures.
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
- OpenAPI-generated projects place operation plans and HTTP behavior inside one
  typed outbound connector, validate allowlisted configuration synchronously at
  the executable composition root, inject only narrow operation ports into the
  pure engine assembly, validate external responses before returning port
  values, and keep connector metadata out of the engine catalog. Fake-port tests
  import only the pure assembly and require no credentials or network access.
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

## Mounted installer URLs (ADR 0040)

Issue #75 was reproduced with `install --http brain` and a Gateway resource at
`http://127.0.0.1:3100/e/brain/mcp`. Test-first validation found seven failures in
remote-source/registry/state acceptance and six in target inverse conversion.
After the shared URL validator change, all 698 installer tests passed, followed
by the full repository gate and the documentation application's validation.

The exact `npx @invokta/installer install --http brain` command was also exercised
from the rebuilt source checkout against that URL. It reached client selection;
the smoke test cancelled before confirmation or configuration writes. The live
endpoint returned the expected OAuth 401 challenge and its path-specific RFC 9728
metadata. No capability was invoked and no OAuth credentials were acquired.
This initial smoke verified the source build. Installer 0.8.1 and earlier reject
mounted endpoints; the compatible release is 0.8.2.

## Release 0.8.2 preparation

The release synchronizes all 10 public package versions, exact internal pins,
example manifests, release assertions, and MCP client identification. The
self-hosted OAuth example's committed lockfile uses integrity values derived
from the matching locally packed artifacts. The changelog and installer
reference identify 0.8.2 as the mounted-URL fix from ADR 0040.

The full repository and documentation gates and both audits were rerun
for this release. These results establish local preparation evidence;
publication requires the annotated release tag's successful GitHub Actions
workflow and its protected npm environment approval.

The first release PR CI run exposed a 25 ms deadline in the existing session
lock recovery test. The successful recovery path now uses the store's normal
lock budget; the live-owner rejection still exercises the short deadline.
The CI timeout is the RED evidence. All 14 session example tests and the full
repository gate passed after this test-only correction, with 3,178 passing tests
and one intentional skip for that release.

## Release 0.8.2 example lockfile follow-up

Registry verification found that three local tarballs had executable command
file modes while CI's tarballs used regular file modes. Every archived file's
content matched, but the different modes changed the installer, deploy, and
devtools integrity hashes. The example lockfile now uses the published hashes.

An isolated `npm ci` also exposed the missing `@invokta/tooling@0.8.2` entry.
After synchronizing that entry with the manifest, `npm ci --ignore-scripts
--no-audit --no-fund` installed all 211 packages successfully. This follow-up
changes example metadata and release guidance, not the published packages.

## Multiple managed installation removal (ADR 0041)

The first focused regression installed the same mounted HTTP engine in two
isolated client configurations. Against the previous implementation, removal
left the Cursor installation and its state record behind after removing only
Codex. After switching argument-free removal to the shared multiselect prompt,
that test passed.

All 12 new session tests pass against real temporary configuration and state
files. They cover one confirmation, empty and cancelled selection, refused and
cancelled confirmation without writes, unknown-choice rejection, deterministic
deduplication, several engines in one client, preservation of unselected and
drifted entries, locked revalidation with partial failures, native and detached
disabled entries, and distinct persisted descriptors for the same engine in
different clients. Removal requires no runtime or credential values. The full
repository and documentation gates passed with the current totals above.

A terminal smoke test of the built CLI showed 16 unselected installations. The
`A` shortcut selected every eligible entry, Enter displayed all engine/client
pairs, and the single confirmation defaulted to No. Refusing returned exit
status 0. SHA-256 comparisons proved all nine involved configuration and state
files byte-identical afterward; no live installation was removed.

This evidence initially covered the source build: published installer 0.8.2
removes one interactively selected installation per command. The feature slice
did not change release versions or publish packages; release 0.9.0 carries the
multiple-selection behavior.

## Release 0.9.0 preparation

The release follows the repository's minor-version policy for added
functionality. It synchronizes all 10 public versions, exact internal package
and example pins, release assertions, and MCP client identification. The
changelog and installer reference identify 0.9.0 as the multiple-removal
release from ADR 0041. This preparation is metadata-only and adds no executable
behavior, so it uses the documentation/tooling exception to a new RED test; the
feature's RED/GREEN evidence remains recorded above.

The full repository gate passes with 3,190 tests and one intentional skip, the
coverage totals above, and 19 example gates. The documentation gate passes all
15 tests, zero Astro diagnostics, and 49 built pages. Both dependency audits
were rerun with the counts above. A clean throwaway checkout produced all 10
release tarballs; the self-hosted OAuth example's seven locked Invokta packages
use those artifacts' SHA-512 integrity values, derived before a workspace
installation can alter generated command file modes. No dependency versions
outside the Invokta package set changed.

`yarn release:pack` passes all 10 package dry-runs. `yarn release:verify` passes
from the staged release tree, including clean tarballs, isolated ESM imports,
all four generated engine profiles, authenticated MCP HTTP, DevTools doctor,
and atomic and capability-library consumers. Publication remains subject to
the release PR CI, the annotated tag's Verify job, and the protected npm
environment. Registry integrity and a clean example `npm ci` must be checked
again after publication.
