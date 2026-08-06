# Engine devtools dev server specification

Status: Accepted by ADR 0020

Contract review verdict: **APPROVED WITH CONDITIONS** (conditions listed in the
verdict section)

## Summary

Invokta adds one supporting application, `@invokta/devtools`, exposing the
`invokta-devtools` executable with two commands:

- `invokta-devtools doctor <esm-module>` runs read-only development-time checks
  against a built engine module and reports deterministic diagnostics.
- `invokta-devtools serve <esm-module>` loads the built engine, serves it
  through the existing `@invokta/mcp` stateless Streamable HTTP adapter on a
  loopback port, and serves a local web interface on a second loopback port.

The web interface lets an engine developer browse capabilities and their JSON
Schemas, invoke a capability by editing schema-derived JSON, inspect the raw
MCP request and response for each invocation, follow a live invocation trace,
switch between test identities backed by development principals, and read the
doctor report.

All built-engine tabs use the same compact, bounded workbench surface. The
Playground presents each top-level input and output field with its declared
type, required state, description, and common constraints while keeping the
complete JSON Schema available for inspection. This presentation does not
convert, normalize, or replace the schema published by `engine.describe`.

Capability execution happens exclusively through an unmodified `serveMcpHttp`
instance, so every invocation traverses the single `engine.invoke` pipeline
with source `mcp-http`. The devtools adds no runtime concept, no core hook, and
no new execution path.

The durable decision is recorded in ADR 0020.

## Problem

Building an engine today has no interactive feedback loop:

- every generated entry point executes `node dist/*.js`, and only
  `mcp:install` builds first, so stale build output is easy to run unnoticed;
- invoking a capability requires hand-written JSON in shell quoting even though
  `engine.describe` already publishes full input and output JSON Schemas;
- seeing an engine as an MCP client sees it requires spawning a process and
  framing JSON-RPC by hand or adding the MCP SDK as a test dependency;
- the composition root fixes one principal, so exercising `access` rules as a
  different actor requires editing source and rebuilding; and
- the `onEvent` hook exists but no supporting tool consumes it.

## Goals

- Give engine developers one local command that turns a built engine into an
  inspectable, invocable development surface.
- Keep every capability execution on the single `engine.invoke` path through
  the existing MCP HTTP adapter.
- Reuse the published `describe` JSON Schemas for presentation without adding a
  schema conversion contract.
- Let the developer define and switch test identities backed by development
  principals through the HTTP authentication hook, the boundary that already
  owns principal production.
- Provide a bounded, in-memory, session-scoped invocation trace.
- Provide deterministic read-only doctor diagnostics with stable exit codes.
- Optionally watch the project and restart the engine host after the project's
  own build command succeeds.

## Non-goals

- A production observability platform, event persistence, aggregation,
  metrics, or export. The trace is an in-memory development aid.
- A second cross-cutting hook, richer core events, or payload capture inside
  any runtime package.
- A new `ExecutionContext.source` value, adapter, or transport.
- Engine discovery, configuration files, a registry, or multi-engine
  management. The module path is always explicit.
- MCP resources, prompts, sampling, elicitation, tasks, stateful sessions,
  resumption, or server-to-client requests.
- Evaluation, judging, release gating, or replay.
- In-process module reloading of any kind. Watch mode replaces the engine host
  process after an explicit external build.
- Non-loopback binding, TLS, or remote access. The devtools is a local
  development tool.
- Editing project files. The devtools never writes to the developer's project.

## Command contract

```text
invokta-devtools doctor <esm-module> [--export <name>]
invokta-devtools serve <esm-module> [--export <name>] [--port <number>]
  [--engine-port <number>] [--watch --build <command>]
```

`<esm-module>` is a path to a built native ESM module, resolved against the
working directory exactly as `invokta check-capabilities` resolves its module
argument. `--export` defaults to `engine`, the documented composition-root
convention. Duplicate options, missing values, unknown options, unknown
commands, extra positionals, a non-integer port, and `--watch` without
`--build` (or `--build` without `--watch`) are invalid usage.

`--port` selects the devtools interface port and defaults to `4100`.
`--engine-port` selects the engine host port and defaults to an ephemeral
loopback port. Both servers bind `127.0.0.1` only; there is no option to bind
another interface.

Diagnostics are line-oriented, deterministic, English, secret-free, and
written only to standard error, with embedded values JSON-quoted. Standard
output carries no output in MVP commands except the single `serve` ready line:

```text
Invokta devtools listening on http://127.0.0.1:<port>/
```

Exit codes follow the supporting-tool convention:

| Exit | Meaning |
| ---: | --- |
| `0` | Doctor found no findings, or `serve` shut down cleanly on SIGINT/SIGTERM |
| `1` | Doctor findings, or a `serve` runtime failure such as an occupied port |
| `2` | Invalid usage, module load failure, missing export, or a non-engine export |

## Engine loading

Both commands load the engine the same way:

1. Resolve the module path against the working directory and convert it to a
   `file://` URL before dynamic import, so a bare relative specifier cannot
   resolve against the devtools package.
2. Import the module. A load failure is reported without a stack trace and
   exits `2`.
3. Read the selected export with an own-property check. A missing export exits
   `2`.
4. Verify the export is an engine: an object with string `name` and `version`
   and callable `invoke`, `list`, and `describe`. Anything else exits `2`.

The devtools performs no directory scanning, package discovery, configuration
lookup, or registry access.

## Doctor contract

Doctor evaluates, in this order, after loading succeeds:

1. `list()` returns an array of capability summaries.
2. `describe(id)` succeeds for every listed capability.
3. Every description exposes object-typed `inputSchema` and `outputSchema`.
4. Advisory notes: capabilities without `title` or `annotations`, and the
   presence or absence of `invokta.mcp.json` in the working directory.
5. When the module also exposes a composed `capabilities` export, the report
   advises running `invokta check-capabilities` for composition provenance.

Failures of checks 1–3 are findings and exit `1`. Notes alone exit `0`.
Doctor never invokes a capability, never starts a transport, never mutates the
filesystem, and performs no network request. `serve` runs checks 1–3 as its
preflight and refuses to start on a finding.

## Serve contract

`serve` starts two loopback HTTP servers.

### Engine host

The engine host is the existing `serveMcpHttp` adapter, configured with:

- `host: "127.0.0.1"` and the selected or ephemeral port;
- `allowedOrigins` containing exactly the devtools interface origin; and
- `auth: { mode: "required" }` with a devtools-owned `authenticate` hook.

The engine value passed to the adapter is an observing delegate: an object
whose `name`, `version`, `list`, and `describe` delegate directly and whose
`invoke` records a started timestamp, then delegates with unchanged arguments,
then records duration and outcome (or the normalized failure), and returns the
result or rethrows the error unchanged. The delegate never reads or stores
capability handlers, never constructs an execution context, and never alters
arguments, results, errors, or timing-relevant behavior. The developer's own
`onEvent` hook, fixed at `createEngine`, continues to fire unchanged.

The `dangerously-disabled-for-development` authentication mode is never used.

### Principals

The devtools maintains an in-memory map from opaque bearer tokens to
development principals. It starts with one default principal whose `id` is
`local-dev`. The interface can create, list, and delete principals; each
principal receives a random token minted with cryptographic randomness. The
`authenticate` hook resolves a presented token to its principal and returns
`null` for an unknown or absent token, producing the adapter's own 401 Bearer
challenge. Tokens and principals never leave process memory and never appear
in diagnostics.

The interface labels this surface **Test identities**, uses **Act as** for the
invocation selector and **Add identity** for creation, and retains **Principal
ID** as the technical field label. These labels do not rename the `Principal`
contract, `/api/principals` routes, or their wire representations.

### Devtools interface server

One origin serves everything the browser touches:

| Route | Behavior |
| --- | --- |
| `GET /` and `GET /assets/*` | Static interface bundle shipped in the package |
| `GET /api/engine` | Engine name, version, capability count, engine host address |
| `GET /api/capabilities` | The `list()` summaries joined with their `describe` output |
| `GET /api/doctor` | The doctor report for the loaded engine |
| `GET /api/events` | `text/event-stream` of trace records and lifecycle notices |
| `GET/POST/DELETE /api/principals` | Manage development principals; responses never include tokens of other principals beyond issuance |
| `POST /mcp` | Same-origin proxy to the engine host |

The proxy forwards method, body, `Authorization`, `Accept`, `Content-Type`,
and the browser `Origin` verbatim, rewrites only the `Host` header to the
engine host authority, and streams the response bytes back unchanged,
including `401` challenges and SSE-framed bodies. The proxy captures request
and response bodies of the exchanges it carries for the trace; invocations
reaching the engine host without passing through the proxy are traced only
with the delegate's minimal fields.

The interface server emits no `Access-Control-*` header on any response. It
validates the `Host` header of every request against its bound authority and
rejects any non-GET request whose `Origin` is present and different from its
own origin, mirroring the adapter's DNS-rebinding posture.

### Trace

The trace store is a bounded in-memory ring buffer (default capacity 500)
correlating delegate records with proxy captures by arrival order and
`Mcp-Session`-free stateless matching. When full, the oldest record is
dropped. Nothing is persisted, exported, or aggregated.

## Watch contract

With `--watch`, the engine runs in a child host process started from a
devtools-owned entry that loads the module, starts the engine host, and
reports its state on a stderr line protocol. The watcher observes the project
working directory recursively — ignoring dependency directories, dot-prefixed
entries, and the directory containing the built module, so its own build
never retriggers it — debounces changes, runs the explicit `--build` command
with the project working directory, and only after the build exits `0`
terminates the child and starts a replacement. A failed build leaves the
running child untouched and reports the failure. The interface receives an
`engine-restarted` notice through the event stream.

The devtools never reloads a module in process, never guesses a package
manager or build command, and spawns no process other than the child host and
the explicit build command.

## Requirements

### AE-DEVTOOLS-01: Package charter

`@invokta/devtools` MUST be a native ESM, binary-only supporting application
that depends only on the public APIs of `@invokta/core` and `@invokta/mcp`
and Node.js built-ins. No runtime package may depend on it. It MUST NOT
publish runtime contracts, capabilities, adapters, or a second capability
execution path.

### AE-DEVTOOLS-02: Explicit loading and stable diagnostics

Engine loading MUST use an explicit module path and export name with no
discovery. Diagnostics MUST be deterministic, English, stack-free,
secret-free, stderr-only, and JSON-quote embedded values. Exit codes MUST
follow the `0/1/2` contract above.

### AE-DEVTOOLS-03: Single execution path

Every capability execution MUST reach the engine exclusively through an
unmodified `serveMcpHttp` instance calling `engine.invoke` with source
`mcp-http`. The observing delegate MUST delegate `invoke`, `list`,
`describe`, `name`, and `version` unchanged, MUST NOT access capability
definitions or handlers, and MUST NOT alter arguments, results, or errors.

### AE-DEVTOOLS-04: Fail-closed development authentication

The engine host MUST always run with `auth.mode: "required"` and a hook that
maps devtools-minted opaque bearer tokens to in-memory principals, returning
`null` otherwise. The disabled authentication mode MUST NOT be used. Both
servers MUST bind only `127.0.0.1`.

### AE-DEVTOOLS-05: Single browser origin

The browser interface MUST be served from one origin that also proxies
`POST /mcp` to the engine host, rewriting only the `Host` header. The engine
host MUST allow exactly the devtools origin. Neither server may emit
`Access-Control-*` headers, and the interface server MUST validate `Host` and
reject foreign-`Origin` non-GET requests.

### AE-DEVTOOLS-06: Bounded session trace

The trace MUST be an in-memory bounded buffer scoped to one `serve` process.
Request and response payloads MUST be captured only from exchanges carried by
the devtools proxy. The trace MUST NOT be persisted, exported, or transmitted
anywhere except the local event stream.

### AE-DEVTOOLS-07: Read-only doctor

Doctor MUST NOT invoke a capability, start a transport, mutate the
filesystem, or perform network requests. Its checks and their order MUST be
deterministic, findings MUST exit `1`, and notes alone MUST exit `0`.

### AE-DEVTOOLS-08: Watch by process replacement

Watch mode MUST rebuild only through the explicit `--build` command and MUST
apply changes only by replacing the engine host child process after a
successful build. In-process module reloading is prohibited. A failed build
MUST leave the running host untouched.

## Acceptance matrix

| ID | Requirement | Contract test and evidence |
| --- | --- | --- |
| AC-DEVTOOLS-01 | 02 | Fixture modules prove exit `2` with exact stderr lines for load failure, missing export, and a non-engine export, and exit `0` for a valid engine. |
| AC-DEVTOOLS-02 | 07 | A fixture engine whose `describe` throws yields a finding and exit `1`; advisory-only fixtures exit `0`; doctor fixtures observe no capability execution. |
| AC-DEVTOOLS-03 | 03, 04 | Against a real `serveMcpHttp` host, an authenticated `tools/call` succeeds and the delegate records started and completed with duration; the result deep-equals a direct `invoke` of the same input. |
| AC-DEVTOOLS-04 | 04 | A request without a token receives the adapter's own 401 Bearer challenge; an unknown token receives 401; a request with a disallowed `Origin` receives 403. |
| AC-DEVTOOLS-05 | 03 | A fixture engine with its own `onEvent` counter proves the developer hook still fires for proxied invocations. |
| AC-DEVTOOLS-06 | 05 | Interface responses for every route contain no `Access-Control-*` header; a foreign-`Origin` POST is rejected; proxied bytes, including a 401 challenge and an SSE-framed body, pass through unchanged. |
| AC-DEVTOOLS-07 | 06 | The event stream emits one record per invocation; the buffer drops oldest records at capacity; payloads appear only for proxy-carried exchanges. |
| AC-DEVTOOLS-08 | 05, 06 | Route contract tests cover `/api/engine`, `/api/capabilities`, `/api/doctor`, `/api/principals`, and static serving of the shipped bundle. |
| AC-DEVTOOLS-09 | 08 | In a temporary fixture project, a source edit followed by the explicit build replaces the child and serves the new behavior; a failing build leaves the old host serving. |
| AC-DEVTOOLS-10 | 01 | The packed tarball passes the release verification list, ships the interface bundle, and an isolated consumer smoke test runs `doctor` against a generated engine. |
| AC-DEVTOOLS-11 | 01..08 | Repository validation passes typecheck, lint, formatting, tests, coverage, build, and packed-tarball inspection with the new package registered. |

## Compatibility and migration

`@invokta/devtools` is a new package; no existing package changes behavior.
Generated starters gain the development dependency, an explicit `devtools`
build-and-watch script, and a build-first `devtools:doctor` diagnostic script.
This changes starter snapshots and is released as a creator change with release
notes. Existing generated projects are unaffected and can adopt the devtools by
installing the package and running `invokta-devtools serve dist/engine.js`.

## Required architecture decision

ADR 0020 must supersede the nine-package count established by ADR 0014,
ADR 0012, and ADR 0004 while preserving their dependency direction and
package isolation; charter the `devtools → core, mcp` dependency edges; grant
the devtools its bounded process-spawning surface (engine host child and the
explicit build command); and record the prohibition list above.

## Contract review verdict

**APPROVED WITH CONDITIONS**

1. The observing delegate must be covered by a test proving byte-identical
   results against direct `invoke` for success and failure outcomes.
2. Watch mode ships only with the child-process host; any in-process reload
   attempt is a contract violation, not an optimization.
3. The starter integration lands only after the packed devtools passes the
   isolated consumer smoke test.
