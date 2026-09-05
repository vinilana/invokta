# Changelog

All notable changes to Invokta are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Interactive `remove` supports selecting multiple managed installations, with
  Space for individual choices and A to select all eligible entries. One
  confirmation reviews the selected engine/client pairs; removals preserve
  unselected entries and report independent successes and failures (ADR 0041).

### Fixed

- The self-hosted OAuth example's lockfile includes `@invokta/tooling` and the
  published 0.8.2 tarball integrity values, restoring clean `npm ci` installs.

## [0.8.2] - 2026-09-05

### Fixed

- The installer accepts canonical mounted MCP URLs such as `/e/brain/mcp`
  instead of rejecting them with `REMOTE_INVALID`. Direct remote installation,
  registry entries, persisted state, and client configuration conversion now
  preserve the full resource path using one validator. Existing `/mcp` URLs and
  the HTTPS, literal-loopback HTTP, and credential restrictions remain unchanged
  (ADR 0040).

## [0.8.1] - 2026-09-04

### Fixed

- Release verification now runs on Node.js 24 with npm 11, avoiding the npm 10
  Arborist peer-resolution crash that blocked the `v0.8.0` tag workflow. The
  published packages continue to support Node.js 22.20.0 and later.

## [0.8.0] - 2026-09-03

### Added

- `serveMcpHttp` accepts an optional `path` that mounts the stateless MCP HTTP
  endpoint under a prefix such as `/e/orders/mcp`, so several engines can share
  one origin, each with its own resource identifier. The default stays `/mcp`.
  A mount path is validated before listening, the Protected Resource Metadata
  resource must use exactly that path, and its document is served at the RFC
  9728 path-suffix location. `invokta-deploy probe` and `inspect-oauth` accept
  the same mount paths and send their request to the path as written
  (ADR 0039).

## [0.7.0] - 2026-08-22

### Added

- `create-invokta-engine --openapi` imports supported operations from a bounded
  local OpenAPI 3.1.x JSON or YAML contract. Eligible endpoints are selected by
  default, interactive and repeatable `--exclude` selection removes unwanted
  capabilities, and generated source infers supported server, parameter, JSON
  body, response, and upstream authentication mechanics without importing
  credentials or contacting the described API.

- ADR 0036 and the outbound connector authoring guide define provider- and
  technology-specific port implementations as explicit custom-engine
  dependencies, with construction-time configuration validation, finite access
  deadlines, no core registry, and no alternate execution path. The crawl,
  image, observability, Obsidian, and agent-session examples provide canonical
  network and filesystem patterns.
- ADR 0037 adds the optional `defineConnector` core authoring API for
  synchronous Standard Schema configuration, opaque dependencies, and frozen
  named-port containers. Connector definitions remain explicitly composed and
  do not add runtime registration, discovery, lifecycle, or another invocation
  path; the Firecrawl example provides the canonical capability integration.
- The `auth-jwt-bearer`, `auth-auth0`, `auth-cognito`, and `auth-workos`
  examples now accept ordered OAuth challenge scopes and serialize them into
  the 401 Bearer challenge, so an OAuth-capable MCP client learns what to ask
  for from the challenge instead of guessing. Each composition root reads them
  from its own environment variable — `AUTH_JWT_CHALLENGE_SCOPES`,
  `AUTH0_MCP_CHALLENGE_SCOPES`, `COGNITO_CHALLENGE_SCOPES`, and
  `WORKOS_MCP_CHALLENGE_SCOPES` — and refuses to start when they are named
  without the example's Protected Resource Metadata resource. The same four
  examples gain `deploy:inspect-oauth` for the credential-free discovery
  inspection.
- Every example that exports a constructed engine now runs the same
  development toolchain a generated project gets: `check:mcp` for the
  build-time MCP conformance gate (ADR 0026), plus `devtools` and
  `devtools:doctor` for Invokta DevTools. The provider-backed crawl, image,
  observability, and Obsidian engines compose only with credentials, so they
  gate their portable MCP tool names with `validateMcpToolCatalog` in their own
  tests and ship `devtools:verify` for the built stdio adapter;
  `support-harness` verifies the engine it consumes the same way.
- `yarn run check` now runs `invokta check-mcp` and `invokta check-capabilities`
  over every built example, so an example cannot drift out of MCP conformance
  without failing the repository check.

### Changed

- OpenAPI-generated engines now compose their inferred HTTP integration through
  one typed outbound connector and inject only narrow operation ports into
  capabilities. Generated connector construction synchronously validates and
  snapshots allowlisted configuration, while connector response validation
  translates schema-invalid external data to a sanitized execution failure.
- The image, observability, Obsidian, and agent-session examples now compose
  their provider and filesystem implementations through `defineConnector` and
  inject only named engine-owned ports. Generated engine instructions and the
  `develop-invokta-project` skill now teach the same connector boundary while
  keeping the starter itself deterministic and provider-free.
- `composed-engine` runs `check-capabilities` through the published `invokta`
  binary instead of a relative path into `packages/tooling/dist`.

### Fixed

- Generated OpenAPI test tables now preserve literal capability IDs, and the
  runtime fixture type-checks the generated test project so a scaffold cannot
  pass repository tests while its own `npm run check` fails.
- Hardened generated OpenAPI engines so operation paths cannot replace the
  configured server origin before credentials are applied, combined security
  schemes cannot overwrite one destination, multi-success output schemas keep
  their required object root, repeated path placeholders are all substituted,
  and generated fake-port tests always execute contract and isolation coverage,
  adding successful response variants when bounded valid witnesses are proven
  and asserting stable response facts after validation transforms.
- Bounded and memoized local OpenAPI reference resolution, aligned parameter
  eligibility with non-null runtime serialization and constrained `deepObject`
  values, and made generated module basenames deterministic, length-bounded,
  collision-checked after bounding, and portable across Windows device-name
  rules.
- Bounded generated-test witness construction, proof, and source serialization
  before allocating from schema length or item bounds, and prevented the
  sampler from constructing or executing document-controlled regular
  expressions.
- The Firecrawl outbound connector now truncates provider batches at the
  requested page limit and bounds follow-up pagination requests to 50 by
  default, preventing oversized or empty provider batches from creating
  unbounded work.
- `create-invokta-engine --example` now ignores links and unsupported archive
  entry types outside the selected template subtree while still rejecting them
  inside it and rejecting path escapes across the whole archive. This restores
  official example imports after a sibling example added a `CLAUDE.md` symlink.
  That example now uses a portable regular instruction file, so importing it
  also works on Windows without symbolic-link privileges. Raw USTAR, PAX, and
  GNU paths are checked before Windows separator normalization so backslash
  paths and slash/backslash aliases fail safely instead of colliding.

## [0.6.1] - 2026-08-20

### Fixed

- `create-invokta-engine` falls back to a regular file copy when a symbolic
  link cannot be created. Creating `CLAUDE.md` as a link to `AGENTS.md` fails
  with `EPERM` on Windows without Developer Mode, which failed the whole
  scaffold with `WRITE_FAILED`.
- The scaffolded projects now request `vitest` as `^4.1.10` instead of the exact
  `4.1.10`. The exact pin left two `vitest` versions in the dependency graph —
  the pinned one and the `vitest@*` peer that `@vitejs/devtools-vitest` resolves
  to the latest release — and npm 10's dependency resolver crashed on that peer
  set with `Cannot read properties of null (reading 'edgesOut')`, so
  `create-invokta-engine`, `create-invokta-capability`, and
  `create-invokta-capability-library` failed to install dependencies on the npm
  that ships with Node 22.

## [0.6.0] - 2026-08-15

### Added

- `invokta-devtools open --cli` starts an idle loopback CLI workbench for
  installed Invokta CLI inspection and homologation (ADR 0032).
- `invokta-devtools open` now serves both idle workbenches from one loopback
  origin and lands on a chooser (ADR 0033): `/` chooses, `/mcp` is the MCP
  workbench, `/cli` is the CLI workbench, and both the workbench header and an
  idle workbench's Connect view link back to the chooser and across to the
  other workbench without restarting the process. `--mcp` is the peer of `--cli`
  and lands on that workbench directly.

### Changed

- Bare `invokta-devtools` and `invokta-devtools open` land on the workbench
  chooser instead of opening the MCP workbench directly; `open --mcp` restores
  the previous landing. The single ready line now carries the workbench path,
  so a reader that matched the whole line has to match the path too.
- Invokta DevTools now serves and prints `http://localhost:<port>/` instead of
  the numeric loopback address. Every loopback authority (`localhost`,
  `127.0.0.1`, and `[::1]`) still reaches the same server, and an OAuth
  redirect keeps the literal address RFC 8252 and the MCP client require.
- A devtools port that is already in use no longer fails the start: `open` and
  `serve` take the next free port and report
  `port: <requested> is in use, using <selected> instead` on standard error.
- Invokta DevTools now uses one product chrome across every shell: the brand
  lockup is `invokta` + `DevTools`, document titles are `Invokta DevTools`
  for the chooser and `Invokta DevTools · Project workspace`,
  `Invokta DevTools · MCP workbench`, and `Invokta DevTools · CLI workbench`
  for the three surfaces, and the workspace tab formerly labeled Playground is
  now Capabilities.

## [0.5.0] - 2026-08-15

### Added

- `invokta-devtools serve` now emulates a capability call through the execution
  path you select (ADR 0028): direct, CLI, MCP stdio, or MCP HTTP. Playground
  keeps one argument editor and one result view for all four, with an
  adapter-specific record of what was exchanged — request and response bodies
  with the HTTP status, `tools/call` frames, or the command with its standard
  streams and exit code — and Activity tags every emulated call with the
  adapter that carried it. Each emulation performs a real call through the
  published adapter: direct, CLI, and MCP stdio each run in a devtools-owned
  child process that imports the same built module and exits with the call,
  while MCP HTTP reuses the running engine host. `@invokta/devtools` therefore
  depends on `@invokta/cli` as well as `@invokta/core` and `@invokta/mcp`.
- The devtools playground now separates identity from authentication
  (ADR 0029). The acting development `Principal`, including an explicit
  anonymous choice, is selected next to the adapter switch and applies to every
  path; the global `Act as` status is gone. Authentication is shown only for
  MCP HTTP, which additionally gains a target: the devtools host, with the
  identity's session token or no credential, or an external Streamable HTTP
  endpoint the developer runs, with none, bearer, custom-header, or interactive
  OAuth authentication — so the hook an engine actually ships can be exercised
  against the same arguments the other paths use. A credential may name an
  environment variable the dev server reads; every credential stays in process
  memory and is never persisted or echoed back.
- `@invokta/mcp` now reaches an OAuth Authorization Server on a different origin
  than the MCP resource, provided the resource's own Protected Resource Metadata
  advertises it (ADR 0031, amending ADR 0023). Once that server's RFC 8414
  metadata validates with a matching issuer, the endpoints it publishes are
  followed on their own origins too — the shape hosted providers such as
  Cognito actually deploy. That document is still read only from the resource's
  own origin over HTTPS, so the resource remains the authority on who may issue
  tokens for it; the loopback-only redirect, mandatory PKCE, audience binding,
  `state` validation, and in-memory-only credentials are unchanged. Hosted
  identity providers, which every `examples/auth-*` engine demonstrates, were
  previously refused outright. `serveMcpHttp` correspondingly accepts any
  literal-loopback Authorization Server in `auth.resourceMetadata` behind a
  literal-loopback HTTP resource, so a local identity provider on its own port
  can be advertised; a deployed engine still cannot advertise a plain-HTTP one.
- `isForbiddenMcpClientHeader` is exported from `@invokta/mcp`, so a caller
  collecting custom authentication headers can refuse what the client facade
  would refuse at the moment the header is named rather than per call.
- `@invokta/mcp` exposes `inspectMcpOAuth`, a read-only diagnostic that runs the
  OAuth discovery chain — the `401` challenge, Protected Resource Metadata, the
  Authorization Server's RFC 8414 metadata, and whether dynamic client
  registration is advertised — and reports each leg with its own outcome and
  remediation. It authorizes nothing and sends no credential. The devtools
  Playground renders it behind a **Check** action and keeps **Authorize**
  disabled until the chain resolves, so a broken setup names the leg that broke
  instead of failing as authentication as a whole.
- Devtools test identities can now be edited in place, list what each one
  recently managed to do, and present the session token as the MCP HTTP
  credential it is rather than as a missing prerequisite for every adapter.
- The CLI and MCP stdio emulations can run the engine's own built entry point
  instead of the devtools child (ADR 0030), so the composition root that
  decides the principal is the project's — including the `principal: null` the
  generated starter passes. The devtools child remains the default and keeps
  the selected identity; choosing a project entry point turns the identity
  control off and says why, and the reproduction command becomes the command
  the developer would type. The path is named explicitly and must stay inside
  the directory `serve` runs in.
- Added optional ordered OAuth challenge scopes to `@invokta/mcp`, with
  startup validation and immutable Bearer challenge serialization independent
  of Protected Resource Metadata's `scopes_supported`.
- Added the official `auth-self-hosted-oauth-engine` example with PKCE, DCR,
  ES256 resource-specific tokens, rotating refresh tokens, PostgreSQL,
  single-owner login and consent, Caddy/Traefik deployment assets, operating
  documentation, and project-local OAuth/deployment skills.
- Added `invokta-deploy inspect-oauth`, a credential-free, read-only, bounded
  inspection of the MCP challenge, Protected Resource Metadata, OAuth/OIDC
  discovery, Authorization Code, S256 PKCE, registration mechanisms, and an
  advertised JWKS.
- Added real devtools homologation of the official example through DCR, PKCE,
  login, one-click consent, token exchange, authenticated initialization,
  catalog, and a deliberate tool call.
- Added `invokta check-mcp` and `validateMcpToolCatalog` as a build-time
  conformance gate for the actual published MCP catalog. Newly generated MCP
  profiles include the gate in their canonical `check`, so ambiguous derived
  tool names fail before adapter startup, installation, or deployment.

### Fixed

- The engine installer no longer rejects every local Action Engine path on
  Windows with `ENGINE_PATH_UNSAFE` (ADR 0027). Ownership validation now uses
  a platform-aware identity: POSIX platforms keep exact uid and private-mode
  checks, while Windows — where Node exposes no `process.getuid()` and reports
  a constant file owner — relies on the unchanged no-follow, path-identity,
  and home-containment protections, with no-follow opens emulated where the
  kernel flag does not exist. Installing and removing a globally installed
  engine package, such as one under the npm global root, now works on Windows
  for home-relative targets; VS Code and Claude Desktop keep their documented
  platform scope.

### Changed

- MCP stdio and HTTP now publish deterministic portable tool aliases that match
  `^[a-zA-Z0-9_-]{1,64}$`, while direct and CLI invocation keep the original
  capability IDs. Tool calls resolve aliases back through the same
  `engine.invoke` path, and ambiguous aliases fail closed before the server
  connects or listens. MCP clients that hard-code dotted tool names must refresh
  `tools/list` and use the advertised alias.
- Official example imports now rewrite npm lockfile package names together with
  `package.json`, and malformed lockfiles roll back the import.
- MCP Protected Resource Metadata accepts an HTTP Authorization Server only on
  loopback, and only behind an HTTP loopback resource, so a local identity
  provider on its own port can be advertised. Production and cross-origin
  Authorization Server identifiers still require HTTPS.

### Security

- Pinned the transitive `nanoid` dependency to 3.3.18 so development and CI
  tooling no longer resolves the vulnerable zero-size custom-generator
  implementation reported through the Vitest dependency chain.
- Self-hosted Client ID Metadata Documents remain disabled until the example
  has an SSRF-resistant fetch policy. Discovery inspection never accepts
  credentials, follows redirects, prints raw metadata, or mutates the remote
  service.

## [0.4.0] - 2026-08-06

### Added

- Added `@invokta/devtools`, the tenth package (ADR 0021): a development-time
  dev server and doctor for one built engine. `invokta-devtools doctor` runs
  read-only checks with deterministic stderr diagnostics, and
  `invokta-devtools serve` hosts the engine through the unmodified MCP HTTP
  adapter behind minted development bearer tokens while serving a loopback
  web interface with a capability browser, schema-seeded invocation editor,
  raw MCP exchange view, live trace, and test-identity switcher. `--watch --build`
  replaces the engine-host child process after each successful explicit
  build; modules are never reloaded in process.
- `@invokta/devtools` also opens an idle, workspace-independent MCP workbench
  that can attach to one explicit stdio command or Streamable HTTP endpoint.
  The compact interface supports catalog inspection, one deliberate tool call,
  bounded Activity metadata, and ephemeral none, bearer, OAuth Authorization
  Code with PKCE, or custom-header HTTP authentication. OAuth is interactive
  and UI-only; its credentials and protocol state remain in process memory.
  The new `verify` command performs read-only initialization and complete
  `tools/list` validation for local installation checks and remote homologation
  without invoking a tool.
- `@invokta/mcp` now exposes a bounded, plain-type client facade over the
  official SDK for stdio and Streamable HTTP connections. SDK types, transport
  details, credentials, and protocol errors remain contained inside the MCP
  package boundary.
- Generated engine starters now include `@invokta/devtools` as a development
  dependency, explicit `devtools` and `devtools:doctor` scripts for interactive
  development and read-only diagnostics.
- `create-invokta-engine` now accepts an explicit
  `--example <name|github-url>` creation mode with an optional
  `--example-path <subdir>` (ADR 0020). Short names resolve to the official
  `vinilana/invokta` `examples/<name>` trees, and HTTPS `github.com`
  repository and tree URLs
  resolve any public template. The mode is mutually exclusive with `--profile`,
  downloads only from `codeload.github.com` after confirmation or `--yes`,
  rewrites the generated package name to the project directory, and preserves
  the existing target safety, exclusive-write, rollback, and package-manager
  boundaries. Profile creation without `--example` remains offline.
- Added ten authentication examples under `examples/auth-*` — a
  provider-neutral JWT bearer engine plus Supabase, Clerk, Auth0, AWS Cognito,
  Firebase Auth, Better Auth, Auth.js, WorkOS AuthKit, and hashed API-key
  engines — each verifying credentials at the composition root, mapping them
  into the minimal `Principal`, and testing the hook contract offline with
  locally generated keys. Twelve matching documentation recipes, including an
  MCP OAuth discovery walkthrough, ship under a new Authentication group.
- `@invokta/installer` now exposes the `@invokta/installer/engine` subpath with
  `runEngineInstallerCli`, so a distributed engine binary can run the existing
  engine-scoped install and removal sessions against its own package root
  (ADR 0019). The standalone `invokta-installer` command surface is unchanged.
- Generated MCP stdio engines now ship a project-named executable whose
  `install` and `uninstall` commands register or remove the engine in local
  MCP clients without the project checkout. The starter adds `src/bin.ts`, a
  package `bin` entry, a packed `files` list, and `@invokta/installer` as a
  runtime dependency.

### Changed

- Running `invokta-devtools` without arguments now starts the idle MCP
  workbench instead of returning an invalid-usage error. Existing `doctor` and
  `serve` invocations retain their workspace-aware behavior.

### Security

- `create-invokta-engine --example` scans every downloaded archive header
  before extraction and fails closed on absolute, drive-letter, UNC,
  NUL-bearing, or parent-traversing paths and on any entry that is not a
  regular file or directory, so symbolic links, hard links, and device entries
  from a public archive can never reach the file system. Extraction stages into
  a temporary directory, copies only regular files into the target, and rolls
  back on failure.

## [0.3.0] - 2026-08-01

### Added

- Added `create-invokta-capability` and
  `create-invokta-capability-library`, with deterministic private ESM starters
  that prove atomic and library composition through `engine.invoke`.
- Generated engine and capability-library projects now include one `AGENTS.md`
  instruction source and a relative `CLAUDE.md` symbolic-link alias.
- Every generated engine, atomic capability, and capability-library project now
  includes a valid `develop-invokta-project` skill tailored to its architecture
  and test-first workflow.
- Generated engines now include a build-free `mcp:uninstall` command that
  removes the same managed engine identity from every configured MCP client
  through one confirmed, ownership-safe operation.
- Added the pure `@invokta/deploy/scaffold` planner so development-time
  generators can reuse the fail-closed MCP HTTP templates without copying them
  or invoking another CLI.

### Changed

- `create-invokta-engine` now guides terminal users through a project directory,
  one of the `complete`, `mcp-stdio`, `mcp-http`, or `cli` profiles, and a final
  confirmation. Terminal automation must pass `--yes`.
- The default `complete` starter now includes MCP HTTP and the matching
  `@invokta/deploy` development dependency. Focused profiles include and
  document only their selected adapter.
- Non-terminal positional creation remains compatible. Automation that requires
  the former syntax and new deterministic default maps as follows:

  ```text
  create-invokta-engine my-engine --no-install
  create-invokta-engine my-engine --profile complete --no-install --yes
  ```

## [0.2.0] - 2026-07-29

### Added

- Added `create-invokta-engine`, a non-interactive standalone engine creator with
  deterministic, non-overwriting scaffolding and npm, pnpm, and Yarn installation.
- Added one-command local Action Engine installation through the generated
  `mcp:install` script and strict `invokta.mcp.json` manifest.
- Added confirmed, transactional multi-client installation with independent
  per-target results, idempotent reruns, drift detection, and rollback.
- Added interactive `status`, `enable`, `disable`, and `remove` commands for
  installer-managed MCP entries.
- Added offline registration of explicit Streamable HTTP endpoints with
  environment-variable credential references.
- Added VS Code user-profile and Claude Desktop macOS targets, bringing the
  catalog to eleven configuration targets across twelve executable surfaces.

### Security

- Local installation validates owned, no-follow project paths and never imports,
  executes, or reflects on the engine during discovery.
- Remote installation performs no network request and rejects embedded
  credentials, queries, fragments, noncanonical routes, and non-loopback HTTP.
- Client updates use bounded locks, atomic replacements, per-target state, and
  exact configuration rollback when a state commit fails.

## [0.1.0] - 2026-07-29

### Added

- Added the initial native ESM package set for Node.js 22.20.0 and later:
  `@invokta/core`, `@invokta/cli`, `@invokta/mcp`, `@invokta/tooling`,
  `@invokta/installer`, and `@invokta/deploy`.
- Added typed capability contracts, Standard Schema and Standard JSON Schema
  validation, explicit access rules, structured errors, cancellation, timeouts,
  minimal invocation events, and capability composition to `@invokta/core`.
- Added direct, CLI, MCP stdio, and stateless MCP Streamable HTTP execution over
  the same `engine.invoke` pipeline.
- Added the `invokta check-capabilities` development gate for deterministic
  capability composition validation.
- Added the read-only `invokta-installer` inventory for supported local MCP
  clients, including fail-closed target and path evidence.
- Added `invokta-deploy` commands for deterministic HTTP engine scaffolding,
  deployment package generation, and bounded endpoint probes.
- Added the public documentation site, architecture decisions, practical
  recipes, package references, and complete example engines for onboarding,
  support, provider integration, capability composition, development workflows,
  local context, and observability.

### Security

- Added fail-closed input, output, identity, access, schema, and cancellation
  boundaries with sanitized public errors and payload-free invocation events.
- Added strict MCP HTTP route, Host, Origin, content type, UTF-8, authentication,
  request-size, and disconnect handling before capability invocation.
- Added bounded MCP stdio reads and lifecycle cleanup that preserves protocol-only
  standard output and contains late write failures.
- Added clean-tarball verification, isolated consumer imports, executable smoke
  tests, dependency auditing, and pinned GitHub Actions dependencies.

### Known limitations

- `@invokta/installer` provides a read-only inventory in this release. Its
  executable does not modify MCP client configuration.
- Invokta does not provide an identity provider, model router, workflow engine,
  runtime plugin system, eval runner, or production observability platform.
- The deploy toolkit generates reviewable artifacts but does not build images or
  deploy them to a hosting provider.

[Unreleased]: https://github.com/vinilana/invokta/compare/v0.8.2...HEAD
[0.8.2]: https://github.com/vinilana/invokta/releases/tag/v0.8.2
[0.8.1]: https://github.com/vinilana/invokta/releases/tag/v0.8.1
[0.8.0]: https://github.com/vinilana/invokta/releases/tag/v0.8.0
[0.7.0]: https://github.com/vinilana/invokta/releases/tag/v0.7.0
[0.6.1]: https://github.com/vinilana/invokta/releases/tag/v0.6.1
[0.6.0]: https://github.com/vinilana/invokta/releases/tag/v0.6.0
[0.5.0]: https://github.com/vinilana/invokta/releases/tag/v0.5.0
[0.4.0]: https://github.com/vinilana/invokta/releases/tag/v0.4.0
[0.3.0]: https://github.com/vinilana/invokta/releases/tag/v0.3.0
[0.2.0]: https://github.com/vinilana/invokta/releases/tag/v0.2.0
[0.1.0]: https://github.com/vinilana/invokta/releases/tag/v0.1.0
