# Changelog

All notable changes to Invokta are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.0] - 2026-11-05

### Added

- `@invokta/mcp/web` is a portable entry point whose
  `createMcpHttpHandler(engine, options)` returns a Web-standard
  `(request: Request) => Promise<Response>` handler for the stateless MCP
  Streamable HTTP endpoint, so an engine can be mounted in Hono, a Next.js route
  handler, or a Node.js server that accepts a Fetch handler, and deployed to
  Cloudflare Workers, Deno, Bun, or Vercel Edge. It enforces the same
  authentication, Host and Origin allowlists, body limit, mount path,
  protected resource metadata, and JSON-RPC rules as `serveMcpHttp` and calls
  every capability through `engine.invoke`; without `allowedHosts` it accepts
  only loopback host names. The package root also exports the function, and
  `McpHttpHandler` and `McpHttpHandlerOptions` describe it (ADR 0042).
- `@invokta/cli` derives `run` flags from the top-level properties of a
  capability's published input schema, so
  `engine run onboarding.create-welcome-message --name Ada` builds
  `{"name":"Ada"}` and still goes through `engine.invoke` validation. Strings,
  numbers, integers, booleans (`--flag`, `--no-flag`, `--flag=false`),
  single-type enums and constants, and arrays through repeated flags are
  supported in `--name value` and `--name=value` forms. Property names map to
  kebab-case; reserved (`input`, `stdin`, `help`, `format`) and colliding
  spellings fail closed, and nested objects, unions, and other schemas still use
  `--input` or `--stdin`. Flags cannot be combined with `--input` or `--stdin`
  (ADR 0047).
- `help` and `--help` print the CLI usage, and `help <capability-id>` or
  `run <capability-id> --help` prints a deterministic, bounded capability page
  with its title, description, annotations, flags, types, required markers,
  allowed values, declared defaults, and the `--input` alternative. Help is
  written to stdout with exit code `0`. Shell completion is not provided.
- Generated `complete` and `cli` engine READMEs show the flag and help commands
  next to the JSON `--input` example.
- Capabilities can declare stable domain errors in an optional `errors` field,
  keyed by UPPER_SNAKE_CASE codes with a public `description`, an optional
  `retryable` hint, and an optional object-rooted `details` schema, and raise
  them from `run` with the new standalone `CapabilityError` class. Its optional
  type argument checks codes and details against the declaration. The engine
  validates the code and details and publishes the outcome as `DOMAIN_ERROR`;
  undeclared codes, invalid details, and forged errors fail closed as
  `EXECUTION_FAILED`. `describe` lists the declarations with their details
  JSON Schema, `invocation.failed` events carry the `domainCode`, and the CLI
  (exit code `1`) and MCP tool errors include the domain code, retry hint, and
  details (ADR 0045).
- `@invokta/http` is a new runtime package for consumers that do not speak MCP
  (ADR 0048). `createHttpHandler(engine, options)` returns a Web-standard
  `(request: Request) => Promise<Response>` handler with no Node-only imports
  that serves `GET /capabilities`, `GET /capabilities/{id}`,
  `POST /capabilities/{id}`, and `GET /openapi.json` below a validated base
  path. Capability IDs are resolved against the catalog first, so an unknown ID
  is a 404 that never reaches `engine.invoke` or its events; every invocation
  runs through `engine.invoke` with source `http` and the request signal.
  Errors keep the sanitized `code`, `message`, and optional `publicDetails`
  and map to HTTP statuses, with a declared `DOMAIN_ERROR` as 422 (documented
  per capability in the OpenAPI document) and `CANCELLED` as 503. Required or
  explicitly disabled authentication uses the same structural request as MCP
  HTTP, so `createJwtBearerAuthenticator` from `@invokta/auth-jwt` plugs in
  directly; the loopback host allowlist, Origin rejection without an explicit
  CORS allowlist, and a 1,048,576-byte default body limit match the MCP HTTP
  defaults. `createHttpOpenApiDocument` generates the OpenAPI 3.1 document from
  `list` and `describe` only and fails closed on a JSON Schema identifier that
  would occur twice. `@invokta/http/node` adds `serveHttp` for Node, rejecting
  dot-segment targets and duplicated `Host` or `Authorization` headers.
- The `support-engine` example adds a plain HTTP JSON entrypoint that shares one
  development authenticator with its MCP HTTP entrypoint.
- `@invokta/auth-jwt` provides `createJwtBearerAuthenticator`, an optional JWT
  bearer authenticator usable directly as the `serveMcpHttp` `authenticate`
  hook or with any adapter exposing `headers.get` and an optional `signal`
  (ADR 0049). It verifies one configured issuer's signed access tokens with
  `jose` 6.2.12, its only runtime dependency, against a remote HTTPS JWKS URL
  or a local key set. It requires an exact issuer, an audience, an explicit
  asymmetric algorithm allowlist, `sub`, and `exp`, and supports a clock
  tolerance of at most 300 seconds, required scopes, a token length bound of
  8,192 characters by default and 16,384 at most, and a claims-to-principal
  mapper that never receives the raw token. Invalid, expired, not-yet-valid,
  wrongly issued or addressed, unknown-key, disallowed-algorithm, and
  insufficient-scope credentials resolve `null`. A token without `kid` that
  fits several published keys is tried against at most eight of them and
  resolves `null` when none verifies it. Key-set outages and cancellation
  reject with a fixed, causeless `JwtVerificationUnavailableError`, which the
  MCP adapter answers with its sanitized 500. A remote key set is cached for 10
  minutes, refetched for an unknown key at most every 30 seconds, and not
  refetched for 5 monotonic seconds after a failed fetch; meanwhile a fresh
  cache keeps answering and a `kid` missing from it resolves `null`.
- `@invokta/otel` instruments an engine through its existing `onEvent` hook.
  `createOpenTelemetryEventHandler` records one `INTERNAL` span per invocation,
  started at the event's `startedAt` in the caller's active context and ended
  with the measured duration, plus the `invokta.invocations` and
  `invokta.invocation.failures` counters and the `invokta.invocation.duration`
  histogram. Attribute names are stable, principal IDs are recorded only on
  opt-in, error codes are opaque strings, a `DOMAIN_ERROR` records its
  declared domain code on the span and the failures counter, metric attributes
  are bounded, and
  pending spans are capped with eviction. Invocations that reuse a running
  invocation's request ID end their spans early without an outcome instead of
  receiving another invocation's result. `contextFor(requestId)` lets a
  capability nest its own spans under the invocation span. The package depends
  on the exact `@invokta/core` release for types and on the
  `@opentelemetry/api` peer (`^1.9.0`); the core and the other packages gain no
  OpenTelemetry dependency (ADR 0050).
- The `observability-engine` example's provider-backed composition root reports
  invocation spans and metrics to the OpenTelemetry SDK its host registers.
- `@invokta/core` exports `applyMiddleware(capabilities, ...middleware)` with
  the `CapabilityMiddleware` and `CapabilityMiddlewareArgs` types. It returns a
  new frozen capability map whose `run` functions execute the middleware, first
  listed outermost, around the original handler, while every own capability
  property and contract field is kept by identity. Input validation and
  `access` still run before the chain, the timeout and cancellation signal
  cover it, its final result is validated against the output schema, and
  middleware errors, including `CapabilityError` domain errors, are normalized
  like `run` errors. `next()` takes no arguments and starts the next layer at
  most once. A started layer always settles before the invocation does, so no
  part of the chain outlives it. Middleware reads a lazily taken, deep-frozen
  input snapshot, and must not mutate `context.principal`, which it shares with
  `run`. Composed maps keep their composition provenance, so
  `invokta check-capabilities` accepts wrapped compositions.
  `applyMiddleware` leaves the engine, its six stages, and its single `onEvent`
  hook unchanged; a new recipe shows audit logging, rate limiting, and caching
  middleware with their limits (ADR 0051).
- `@invokta/mcp` returns native MCP `image`, `audio`, and `resource_link`
  content blocks, over both stdio and HTTP, for top-level output properties
  that declare standard JSON Schema content keywords (ADR 0044). The forms are:
  - a base64 string with an allowlisted image or audio `contentMediaType`;
  - a media object with an enumerated `mimeType` and one
    `contentEncoding: "base64"` property; or
  - a link object whose `uri` declares `contentMediaType: "text/uri-list"`.

  Each form can be used directly or as array items. `structuredContent`
  remains the complete validated output, and the JSON text block keeps its
  structure while replacing each mapped base64 value with a
  `[content N: <media type>]` placeholder. Each value maps independently: an
  invalid value, or a block type that the negotiated protocol revision does
  not define (audio before `2025-03-26`, resource links before `2025-06-18`),
  stays in the text block. More than 16 planned values fall back to the
  unchanged JSON result. Capabilities without these annotations are presented
  byte for byte as before, and the core, CLI, and direct results are
  unchanged.
- `validateMcpToolCatalog` returns a frozen `McpToolCatalogReport` whose
  `contentWarnings` name annotated output properties that will not produce
  content blocks, and `invokta check-mcp` prints them as `warning:` lines
  while still exiting `0`.
- The private `image-engine` example annotates its generated assets, so MCP
  clients receive each image as a native `image` block. A new documentation
  recipe shows the Zod 4 authoring pattern.
- The [stability policy](./docs/stability-policy.md) defines each package's
  public API, Semantic Versioning before and after 1.0, the deprecation process
  and window, supported Node.js versions, the MCP baseline update rules, how
  security fixes ship, the criteria for 1.0, and which capability contract
  changes are breaking for engine authors (ADR 0046).
- Capability definitions accept an optional
  `deprecated: { reason, since?, replacement? }` notice, validated with bounded
  lengths at engine construction and published by `list()` and `describe()`.
  The CLI prints it in `list`, `describe`, and capability help, and MCP tool
  listings prefix the description with the notice and expose it as
  `_meta["dev.invokta/deprecated"]`. Invocation does not change; the engine
  logger receives one warning per deprecated capability on its first
  invocation (ADR 0046).
- `describe()` publishes the access rule kind as `access`: `public`,
  `authenticated`, or `function`. New `CapabilityDeprecation` and
  `CapabilityAccessKind` types are exported from `@invokta/core`.
- `invokta contract snapshot <esm-module>` writes a deterministic JSON snapshot
  of an engine's public contract, including declared domain errors, and
  `invokta contract diff <previous> <next>` classifies the changes as breaking,
  potentially breaking, or compatible, prints a report, and exits `1` on
  breaking changes (or potentially breaking ones with
  `--fail-on-potentially-breaking`). `@invokta/tooling` also exports
  `runContractCommand`, `createContractSnapshot`, `serializeContractSnapshot`,
  and `diffContractSnapshots` (ADR 0046).
- Capabilities can report advisory progress with
  `context.reportProgress({ progress, total?, message? })` (ADR 0043). Direct
  callers observe frozen snapshots through the new `InvokeOptions.onProgress`
  callback, and `@invokta/core` exports the `ProgressReport` type. Reports are
  validated (finite `progress` of at least zero, positive `total`, messages of
  at most 1,024 UTF-16 code units), non-increasing reports are dropped, and
  delivery happens only while `run` is pending and stops at settlement,
  cancellation, or timeout. Reporting never throws, never waits for the sink,
  and never changes the invocation; sink failures are contained and logged once
  per invocation without payloads.
- MCP stdio and HTTP forward progress as `notifications/progress` when a
  `tools/call` request carries `_meta.progressToken` (a string of at most 256
  UTF-16 code units or a safe integer), echoing the token and sending at most
  one notification per 100 ms per request. A slow reader leaves at most one
  unwritten notification and one held report per request; the held report is
  delivered just before a successful result. `serveMcpHttp` and
  `createMcpHttpHandler` answer such a request with a request-scoped
  `text/event-stream` response that carries its notifications and then its
  result, without connection-scoped headers; cancelling it aborts the
  invocation, and `serveMcpHttp` honors `Connection: close`. Every other
  request keeps the JSON response and all request bounds are unchanged.
- The plain HTTP adapter `@invokta/http` answers with one JSON body and passes
  no progress sink, so `reportProgress` is a no-op for its callers.
- `runCli` in the `human` format writes each progress report as one
  `progress <progress>[/<total>][: <message>]` line to stderr, escaping
  terminal-active characters. The default `json` format ignores progress.
- The `image-engine` example reports liveness immediately and every 15 seconds
  while each provider request is pending, with a progress recipe in the
  documentation site.

### Changed

- The usage text embedded in CLI `INVALID_USAGE` messages lists the flag and
  help forms. `run` arguments other than exactly `--input <json>` or `--stdin`
  are parsed as schema-derived flags, so a flag run against an unknown
  capability now reports `CAPABILITY_NOT_FOUND` with exit code `1` before
  `engine.invoke`, without an invocation event, instead of invalid usage.
  Existing `--input` and `--stdin` invocations, output, and exit codes are
  unchanged.
- `EngineErrorCode` gains `DOMAIN_ERROR`, the only framework code for declared
  domain errors. Exhaustive `switch` statements that assert `never` and
  exhaustive `Record<EngineErrorCode, ...>` maps, including `satisfies` checks,
  must handle it; engines that declare no domain errors never produce it.
- The `support-engine` example reports a missing ticket as the declared
  `TICKET_NOT_FOUND` domain error instead of `EXECUTION_FAILED`, and its local
  operator may access the missing ticket `T-404` to demonstrate it.
- `ExecutionSource` adds `"http"`. Code that switches exhaustively over
  invocation sources must handle the new member.
- `@invokta/core` no longer imports Node.js built-in modules. It uses
  `globalThis.crypto.randomUUID()` and `globalThis.performance.now()`, and reads
  `util.types` through `process.getBuiltinModule` where the host provides it,
  which keeps proxy and promise detection unchanged on Node.js, Deno, and Bun.
  A Node.js process without it refuses to load the core instead of weakening
  those checks; other hosts without it use a documented fallback that still
  rejects proxied JSON values (ADR 0042).
- `serveMcpHttp` is now a Node.js adapter over the same protocol implementation
  as `createMcpHttpHandler`; its options, status codes, and connection handling
  are unchanged, and `ServeMcpHttpOptions` extends `McpHttpHandlerOptions`.
  Portable MCP tool names use a bundled SHA-256 implementation instead of
  `node:crypto`, with identical results.
- AE-LIMIT-04 is amended for the optional JWT bearer helper. Invokta still
  provides no identity provider, token issuer, introspection client, OpenID
  Connect discovery, DPoP, mTLS, policy language, PDP adapter, or session
  binding.
- The private `auth-jwt-bearer-engine` and `auth-auth0-engine` examples use
  `@invokta/auth-jwt` instead of their own `jose` verifiers. Their exported
  helpers change accordingly: `startAuthJwtBearerMcpHttp` takes an
  `authenticate` function instead of a `verifier`, and `startAuth0McpHttp` a
  `keySource` instead of a `verifier`; `createAuth0Authenticator` replaces
  `createAuth0AccessTokenVerifier` and `createAuth0Authenticate`. Bearer
  parsing now requires exactly one space and a compact JWS, the JWT bearer
  example's `AUTH_JWT_ALGORITHMS` accepts only asymmetric algorithms, and its
  new optional `AUTH_JWT_REQUIRED_SCOPES` names scopes every token must grant.
- A capability whose output schema already declared one of the ADR 0044 forms
  now receives content blocks after its MCP text block, and that text block
  carries placeholders instead of the mapped base64 values. MCP consumers that
  parsed the text block for that data must read `structuredContent`.
- `validateMcpToolCatalog` returns a report instead of `undefined`, and
  `invokta check-mcp` is no longer silent when the catalog has content
  warnings. Its exit codes are unchanged.
- `engine.describe()` results, and therefore CLI `describe` output, include the
  new required `access` field. Tests that compare a whole description for exact
  equality must add it, and hand-written `Engine` implementations must return
  it.
- `ExecutionContext` gains the required `reportProgress` member, amending
  `AE-CTX-01` to six fields. Code that builds an `ExecutionContext` by hand,
  such as a unit test that calls `run` directly, must now provide it, for
  example `reportProgress: () => undefined`. An `InvokeOptions.onProgress`
  value that is not a function fails the invocation as `EXECUTION_FAILED`.
- `AE-LIMIT-01` and `AE-LIMIT-05` no longer exclude progress. MCP Tasks,
  streaming partial results, resumption, and persisted progress remain out of
  scope.

### Fixed

- The private `image-engine` example validates base64 images with a linear
  scan. Its regular expression exhausted the stack on images of about 4 MiB,
  well below its 32 MiB limit.
- Release publication waits up to 10 minutes, with checks backing off from 5 to
  30 seconds, for npm to make each published version readable. It previously
  failed after about one minute while npm was still processing the first
  package, which stopped the 0.9.1 workflow after publishing `@invokta/core`.
  The publish job timeout increases from 20 to 150 minutes, so each of the
  thirteen packages can use its full 10-minute wait.

## [0.9.1] - 2026-10-30

### Added

- The private `parallel-search` example uses the `@invokta/mcp` HTTP client
  facade against Parallel's keyless public search MCP server. Each command
  discovers and calls one `web_search` or `web_fetch` tool within a shared
  60-second deadline and closes the connection; its tests use a local MCP HTTP
  fixture and never call the public service.

### Changed

- Refresh the installer JSON parser to Momoa 3.3.13. Authentication examples
  use jose 6.2.12 and the self-hosted OAuth
  provider uses oidc-provider 9.12.2 with PostgreSQL types 8.23.1. The workspace
  and standalone example lockfiles are synchronized with the dependency updates.
- `@invokta/mcp` pins the official MCP TypeScript SDK 1.32.2 instead of 1.30.0
  after the review required by ADR 0006. The protocol baseline remains
  `2025-11-25`, the used SDK subpaths are unchanged, and the adapter's own
  request bounds and manual redirect rejection are unchanged.
- The installer uses @clack/prompts 1.8.1. Development tooling moves to Biome
  2.5.15, Vitest 4.1.12, and Node.js types 26.6.6, the documentation site to
  Astro 7.4.4, and CI to actions/setup-node 7.1.0.

### Security

- Pin the standalone OAuth example's `fast-uri` and `qs` dependencies to patched
  versions 3.1.9 and 6.17.1 through npm overrides. CI now audits that example's
  independent lockfile in addition to the workspace and documentation locks.
- MCP SDK 1.32.2 includes the upstream fixes for HTTP request body and batch
  bounds, OAuth credentials bound to their issuing authorization server, and
  bearer-token audience and task-session checks reported against 1.30.0.
- Generated engine, atomic capability, and capability-library projects pin
  Zod 4.6.7 instead of 4.4.3, and every example uses 4.6.7, fixing memory
  exhaustion when validating oversized constrained collections.
- Workspace resolutions move `fast-uri`, `qs`, and `nanoid` to 3.1.9, 6.17.1,
  and 3.3.20. Locked `proxy-addr`, `body-parser`, `hono`, `@hono/node-server`,
  `ip-address`, `vite`, and `source-map-js` versions move to patched releases in
  the workspace, documentation, and standalone OAuth example lockfiles.

## [0.9.0] - 2026-09-05

### Added

- Interactive `remove` supports selecting multiple managed installations, with
  Space for individual choices and A to select all eligible entries. One
  confirmation reviews the selected engine/client pairs; removals preserve
  unselected entries and report independent successes and failures (ADR 0041).

### Fixed

- The self-hosted OAuth example's lockfile includes `@invokta/tooling` and the
  matching release tarball integrity values, restoring clean `npm ci` installs.

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

[Unreleased]: https://github.com/vinilana/invokta/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/vinilana/invokta/releases/tag/v0.10.0
[0.9.1]: https://github.com/vinilana/invokta/releases/tag/v0.9.1
[0.9.0]: https://github.com/vinilana/invokta/releases/tag/v0.9.0
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
