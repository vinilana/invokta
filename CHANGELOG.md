# Changelog

All notable changes to Invokta are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `invokta-devtools serve` now emulates a capability call through the execution
  path you select (ADR 0027): direct, CLI, MCP stdio, or MCP HTTP. Playground
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
  (ADR 0028). The acting development `Principal`, including an explicit
  anonymous choice, is selected next to the adapter switch and applies to every
  path; the global `Act as` status is gone. Authentication is shown only for
  MCP HTTP, which additionally gains a target: the devtools host, with the
  identity's session token or no credential, or an external Streamable HTTP
  endpoint the developer runs, with none, bearer, custom-header, or interactive
  OAuth authentication — so the hook an engine actually ships can be exercised
  against the same arguments the other paths use. A credential may name an
  environment variable the dev server reads; every credential stays in process
  memory and is never persisted or echoed back.
- The CLI and MCP stdio emulations can run the engine's own built entry point
  instead of the devtools child (ADR 0029), so the composition root that
  decides the principal is the project's — including the `principal: null` the
  generated starter passes. The devtools child remains the default and keeps
  the selected identity; choosing a project entry point turns the identity
  control off and says why, and the reproduction command becomes the command
  the developer would type. The path is named explicitly and must stay inside
  the directory `serve` runs in.
- Added `invokta check-mcp` and `validateMcpToolCatalog` as a build-time
  conformance gate for the actual published MCP catalog. Newly generated MCP
  profiles include the gate in their canonical `check`, so ambiguous derived
  tool names fail before adapter startup, installation, or deployment.

### Changed

- MCP stdio and HTTP now publish deterministic portable tool aliases that match
  `^[a-zA-Z0-9_-]{1,64}$`, while direct and CLI invocation keep the original
  capability IDs. Tool calls resolve aliases back through the same
  `engine.invoke` path, and ambiguous aliases fail closed before the server
  connects or listens. MCP clients that hard-code dotted tool names must refresh
  `tools/list` and use the advertised alias.

### Security

- Pinned the transitive `nanoid` dependency to 3.3.17 so development and CI
  tooling no longer resolves the vulnerable zero-size custom-generator
  implementation reported through the Vitest dependency chain.

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

[Unreleased]: https://github.com/vinilana/invokta/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/vinilana/invokta/releases/tag/v0.4.0
[0.3.0]: https://github.com/vinilana/invokta/releases/tag/v0.3.0
[0.2.0]: https://github.com/vinilana/invokta/releases/tag/v0.2.0
[0.1.0]: https://github.com/vinilana/invokta/releases/tag/v0.1.0
