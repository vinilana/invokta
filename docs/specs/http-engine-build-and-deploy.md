# HTTP engine build and deploy toolkit

- Status: Draft
- Target: Post-v0.1
- Change type: Additive development-time package and CLI
- Date: 2026-07-28

## Summary

An engine that exposes MCP Streamable HTTP through `serveMcpHttp` is already a
complete stateless server, but turning it into something a team can actually
run in a shared environment is manual work today. Every author hand-writes the
HTTP composition root, invents environment-variable names for host, port, and
allowlists, writes a Dockerfile from scratch, and has no standard way to verify
that a deployed endpoint is alive and serving MCP.

This specification defines a development-time toolkit that closes that gap with
three non-interactive commands:

| Command | Responsibility |
| --- | --- |
| `ai-engine-deploy init` | Scaffold a deployment manifest and a production-shaped HTTP composition root that fails closed until authentication is implemented. |
| `ai-engine-deploy package` | Generate a deterministic, reviewable deployment package: `Dockerfile`, `.dockerignore`, a self-contained health-check script, and generated deployment documentation. |
| `ai-engine-deploy probe` | Perform one bounded MCP liveness or readiness check against a running endpoint, for CI smoke tests and container health checks. |

The toolkit generates and validates text. It never runs Docker, a package
manager, a shell, or the engine itself, and its only network operation is the
single HTTP request made by an explicit `probe` invocation. Deployment remains
the host's responsibility: the output of `package` is a conventional container
build context that any OCI builder and any container platform can consume.

## Relationship to the existing architecture

This specification is a post-v0.1 expansion. It changes no v0.1 contract:

- `@ai-engine/core`, `@ai-engine/cli`, and `@ai-engine/mcp` are not modified.
  The generated composition root uses only the existing public
  `serveMcpHttp` API and its documented options (`host`, `port`,
  `allowedHosts`, `allowedOrigins`, `maxRequestBodyBytes`, `auth`).
- The single `engine.invoke` execution path of ADR 0003 and ADR 0005 is
  untouched. The toolkit never imports an `Engine`, never calls a capability,
  and never starts an adapter.
- The stateless HTTP profile of ADR 0007 is taken as given. The toolkit does
  not add sessions, resumption, sticky routing, or an in-adapter TLS or health
  endpoint. Liveness is observed from the outside through the existing `/mcp`
  boundary behavior.
- The toolkit is not the local capability MCP installer. The installer
  (ADR 0010) configures MCP clients on an end user's machine; this toolkit
  produces the server-side artifact whose public URL can later appear in an
  installer registry entry. A deployed endpoint that follows this
  specification satisfies the installer's `streamable-http` URL constraints
  (`AE-INSTALL-REG-06`): HTTPS at the public edge and the exact `/mcp` path.

Implementation requires a new ADR before code is added. That ADR must
authorize the post-v0.1 `@ai-engine/deploy` package, amend the package
boundary in ADR 0004, and distinguish this developer-facing generator from the
dev-only build gate `@ai-engine/tooling` (ADR 0009) and the end-user
`@ai-engine/installer` (ADR 0010). The preferred package and binary are:

| Artifact | Responsibility |
| --- | --- |
| `packages/deploy` / `@ai-engine/deploy` | Manifest validation, scaffolding, deployment package generation, probe |
| `ai-engine-deploy` | Non-interactive executable; owns no capability execution command |

No runtime or tooling package may depend on `@ai-engine/deploy`, and
`@ai-engine/deploy` MUST NOT depend on `@ai-engine/core`, `@ai-engine/cli`,
`@ai-engine/mcp`, `@ai-engine/tooling`, or `@ai-engine/installer`. It may use
only Node built-ins. The package is native ESM and declares the repository
runtime floor of Node.js `>=22.20.0`. Generated user code imports
`@ai-engine/mcp`; the toolkit itself does not.

## Goals

1. Let an engine author go from a working engine to a reviewable container
   build context with two commands and no hand-written infrastructure files.
2. Standardize the environment-variable contract of an HTTP engine so every
   deployment of every engine is configured the same way.
3. Make the generated composition root production-shaped by default:
   authentication required, fail-closed startup, graceful shutdown.
4. Make deployment packages deterministic, secret-free, and idempotent to
   regenerate, so they can be committed and reviewed like any other code.
5. Provide one bounded, credential-safe MCP probe usable both in CI and as a
   container health check.
6. Keep every runtime package, the seven-code `EngineError` taxonomy, and the
   single execution path unchanged.

## Non-goals

- Running `docker`, `podman`, `npm`, `yarn`, `pnpm`, `tsc`, or any other
  child process during any command.
- Building, tagging, pushing, signing, or scanning a container image.
- Deploying to, or integrating with, any cloud provider, PaaS, or
  orchestrator; generating Kubernetes, Compose, Terraform, or provider
  manifests.
- TLS termination inside the adapter or the container. HTTPS is provided by
  the platform edge in front of the engine.
- Secret provisioning, token issuance, OAuth flows, or credential storage.
- A stateful or session-holding HTTP profile; ADR 0007 remains the contract.
- Packaging stdio MCP entry points; this specification covers Streamable HTTP
  only.
- Workspace or monorepo build contexts in the first release. The first
  release targets an engine project whose dependencies resolve from a package
  registry through its own lockfile.
- An interactive terminal UI. All commands are non-interactive and scriptable.

## Terminology

**Engine project**
: A directory containing a `package.json` with a `build` script, exactly one
  supported lockfile, and a buildable HTTP entry module that calls
  `serveMcpHttp`.

**Deployment manifest**
: The closed, versioned JSON document `ai-engine.deploy.json` at the engine
  project root. It is the single input that parameterizes scaffolding,
  packaging, and health checks.

**Deployment package**
: The set of generated files that, together with the project source, form a
  complete container build context: `Dockerfile`, `.dockerignore`,
  `deploy/healthcheck.mjs`, and `deploy/DEPLOYMENT.md`.

**Generated file marker**
: A fixed first-line comment identifying a file as toolkit-generated. Only
  marked files may be overwritten by regeneration.

**Probe**
: One bounded HTTP request against an `/mcp` endpoint that classifies it as
  healthy or unhealthy without invoking any capability tool.

## User-facing CLI

### Commands

```text
ai-engine-deploy init
ai-engine-deploy package
ai-engine-deploy probe --url <url> [--expect alive|ready] [--bearer-env NAME]
                       [--host-header HOST] [--timeout-ms N]
ai-engine-deploy --help
ai-engine-deploy --version
```

All commands are non-interactive and require no TTY. Diagnostics and progress
go to `stderr`; no command writes to `stdout` except `--help` and
`--version`, which follow the same conventions as `@ai-engine/tooling`. The
orchestrating functions return exit codes and never call `process.exit`; the
binary composition root owns the final process status.

### Exit codes

| Exit code | Meaning |
| --- | --- |
| `0` | The command succeeded; for `probe`, the endpoint is healthy. |
| `1` | The command completed but reported failures: a generated-file conflict, a validation failure of project inputs, or an unhealthy probe result. |
| `2` | Invalid usage, a missing or invalid manifest, or an initialization failure. |

### Execution boundaries

**AE-DEPLOY-CLI-01 — No child processes.** No command spawns a process,
executes a shell, or runs a package manager, compiler, or container tool.

**AE-DEPLOY-CLI-02 — Bounded network.** `init` and `package` perform zero
network operations. `probe` performs exactly one HTTP request per invocation
and no retries; retry policy belongs to the caller or orchestrator.

**AE-DEPLOY-CLI-03 — Determinism.** Given the same manifest, `package.json`,
lockfile set, and toolkit version, `init` and `package` produce byte-identical
output. Generated content contains no timestamps, hostnames, usernames,
absolute local paths, or random values.

**AE-DEPLOY-CLI-04 — Idempotence.** Re-running `package` over an unmodified
project rewrites nothing: a byte-identical generated file is reported as
`unchanged` and not written.

## Deployment manifest contract

### Schema

The manifest is `ai-engine.deploy.json` at the engine project root.
TypeScript notation documents the JSON data; the manifest itself is plain
JSON.

```ts
interface HttpDeployManifest {
  readonly schemaVersion: 1;
  readonly entry: string;
  readonly env?: {
    readonly required?: readonly string[];
    readonly optional?: readonly string[];
  };
  readonly image?: {
    readonly baseImage?: string;
    readonly port?: number;
  };
  readonly healthcheck?: {
    readonly expect?: "alive" | "ready";
    readonly bearerEnv?: string;
  };
}
```

Example:

```json
{
  "schemaVersion": 1,
  "entry": "dist/mcp-http.js",
  "env": {
    "required": ["SUPPORT_API_TOKEN"],
    "optional": ["AI_ENGINE_HTTP_ALLOWED_ORIGINS"]
  },
  "image": {
    "port": 3000
  },
  "healthcheck": {
    "expect": "alive"
  }
}
```

### Manifest invariants

**AE-DEPLOY-MAN-01 — Closed schema.** Every object rejects unknown keys.
`schemaVersion` MUST equal numeric `1`; any other value fails the whole
command before any file is inspected or written.

**AE-DEPLOY-MAN-02 — Entry.** `entry` MUST be a relative, NUL-free path with
no `..` segment, resolving inside the project, ending in `.js` or `.mjs`. It
identifies the built ESM entry module started by the container.

**AE-DEPLOY-MAN-03 — Environment names only.** Every `env` and
`healthcheck.bearerEnv` value MUST match `^[A-Z_][A-Z0-9_]{0,127}$`.
`required` and `optional` together MUST be unique and contain at most 64
names. The manifest declares names; it MUST NOT contain credential values,
tokens, or URLs with userinfo.

**AE-DEPLOY-MAN-04 — Image.** `image.baseImage` defaults to `node:22-slim`,
MUST be non-empty, and MUST contain no whitespace or NUL. The image's Node.js
major version MUST satisfy the repository floor; the toolkit validates the
declared tag textually and does not pull the image. `image.port` defaults to
`3000` and MUST be an integer in `1..65535`.

**AE-DEPLOY-MAN-05 — Healthcheck.** `expect` defaults to `alive`. `bearerEnv`
is permitted only when `expect` is `ready`.

**AE-DEPLOY-MAN-06 — Bounded input.** The encoded manifest MUST be at most
65,536 bytes. Every string MUST be at most 1,024 Unicode scalar values.

Validation reports all detectable issues in deterministic JSON-pointer order
and never echoes a rejected value into a diagnostic.

## Scaffolded HTTP composition root

`ai-engine-deploy init` writes, when absent, the manifest and two source
files: `src/mcp-http.ts` (the composition root) and `src/http-auth.ts` (the
authentication hook module). `init` never overwrites an existing file; an
existing target is reported as `skipped` and the command still exits `0`.
The scaffold assumes the conventional `engine` export in `src/engine.ts` and
tells the author to adjust the import when their layout differs.

### Environment contract

The generated composition root implements this contract. It is a convention
of generated application code, not a runtime-package feature:

| Variable | Meaning | Default |
| --- | --- | --- |
| `AI_ENGINE_HTTP_HOST` | Bind host passed to `serveMcpHttp`. | `127.0.0.1` |
| `AI_ENGINE_HTTP_PORT`, then `PORT` | Bind port; the AI Engine name wins when both are set. | `3000` |
| `AI_ENGINE_HTTP_ALLOWED_HOSTS` | Comma-separated `Host` allowlist for non-loopback binds. | unset |
| `AI_ENGINE_HTTP_ALLOWED_ORIGINS` | Comma-separated browser origin allowlist. | unset |
| `AI_ENGINE_HTTP_MAX_BODY_BYTES` | Request body limit override. | adapter default (1 MiB) |

**AE-DEPLOY-ENV-01 — Fail-closed parsing.** List values are split on commas,
trimmed, and empty items dropped. A non-integer or out-of-range numeric
value, or a NUL in any value, MUST abort startup with a clear message rather
than fall back to a default.

**AE-DEPLOY-ENV-02 — Authentication fails closed.** The scaffolded
`src/http-auth.ts` exports the `auth.mode: "required"` hook and throws at
module load with an explicit "implement authentication before deploying"
error until the author replaces it. The scaffold MUST NOT emit
`dangerously-disabled-for-development` anywhere; that mode remains a manual,
local-only choice documented in the getting-started guide.

**AE-DEPLOY-ENV-03 — Graceful shutdown.** The composition root closes the
server handle on `SIGTERM` and `SIGINT` and exits `0` after `close()`
resolves. ADR 0007's shutdown semantics (abort tracked requests, close
connections) make this bounded.

**AE-DEPLOY-ENV-04 — Diagnostics discipline.** The composition root writes
its endpoint announcement and errors to `stderr` only, and never logs header
values or environment values.

## Deployment package generation

### Inputs and validation order

`ai-engine-deploy package` performs, in order:

1. load and validate the manifest;
2. read `package.json`; require a `build` script and a `name` and `version`;
3. detect exactly one supported lockfile: `yarn.lock` (Yarn 1 with
   `--frozen-lockfile`), `package-lock.json` (`npm ci`), or
   `pnpm-lock.yaml` (`pnpm install --frozen-lockfile`); none is
   `LOCKFILE_MISSING`, more than one is `LOCKFILE_AMBIGUOUS`;
4. verify the manifest `entry` exists as a regular file, as evidence that the
   author has built the project; the file content is not inspected;
5. compute the generated file set and compare each existing target against
   the marker policy;
6. write changed files atomically (private temporary file, then rename) with
   UTF-8, LF, and a trailing newline;
7. report each file as `created`, `updated`, `unchanged`, or `conflict`.

Package-manager commands detected in step 3 appear only as text inside the
generated `Dockerfile`; the toolkit never executes them.

### Generated file set

| File | Content |
| --- | --- |
| `Dockerfile` | Multi-stage container build as specified below. |
| `.dockerignore` | Excludes at least `.git`, `node_modules`, `test`, `coverage`, and every `.env*` file. |
| `deploy/healthcheck.mjs` | Self-contained probe script with no dependencies outside Node built-ins. |
| `deploy/DEPLOYMENT.md` | Generated operator documentation: the environment contract, the manifest's declared variables, topology guidance, and the health-check behavior. |

**AE-DEPLOY-ART-01 — Marker policy.** Every generated file begins with a
fixed marker comment identifying the toolkit and its major version. `package`
overwrites a file only when it is absent or carries the marker on its first
line. An unmarked existing file is `GENERATED_FILE_CONFLICT` for that file;
other files are still processed, and the command exits `1`.

**AE-DEPLOY-ART-02 — Dockerfile contract.** The generated `Dockerfile` MUST:

- use the manifest base image for both stages;
- in the build stage, copy the project context, run the detected
  frozen-lockfile install and the `build` script, then produce a
  production-only `node_modules` (`--omit=dev` or the manager's equivalent);
- in the runtime stage, set `NODE_ENV=production`, run as the non-root
  `node` user, set `WORKDIR /app`, and copy only the built output,
  production `node_modules`, `package.json`, and `deploy/healthcheck.mjs`;
- set `AI_ENGINE_HTTP_HOST=0.0.0.0` and `EXPOSE` the manifest port;
- declare `HEALTHCHECK` invoking `node deploy/healthcheck.mjs`;
- end with `CMD ["node", "<entry>"]` using the manifest entry;
- contain no secret, credential, token, registry authentication, or `.env`
  content, and copy no file excluded by `.dockerignore`.

**AE-DEPLOY-ART-03 — Health-check script.** `deploy/healthcheck.mjs`
implements the probe semantics below against
`http://127.0.0.1:<port>/mcp`. Because the adapter validates the raw `Host`
header (ADR 0007), the script sends the first entry of
`AI_ENGINE_HTTP_ALLOWED_HOSTS` as its `Host` header when that variable is
set, so the runtime allowlist does not need to admit loopback hosts. It reads
a bearer token only from the manifest's `healthcheck.bearerEnv` variable and
never prints it.

**AE-DEPLOY-ART-04 — Reviewable output.** Generated files are plain text
intended to be committed. Regeneration after a manifest change updates only
the affected files; unrelated user files are never read or written.

## Probe contract

`ai-engine-deploy probe` and the generated health-check script share one
semantic contract.

**AE-DEPLOY-PROBE-01 — Target URL.** The URL MUST be absolute HTTP(S) without
userinfo, query, or fragment, with the exact `/mcp` path. HTTPS is required
except when the host is exactly `127.0.0.1` or `[::1]`. `--host-header`
overrides the `Host` header for probes that reach a loopback listener whose
allowlist names only public hosts.

**AE-DEPLOY-PROBE-02 — One bounded request.** The probe sends one MCP
`initialize` request via HTTP POST, with the protocol version pinned by
ADR 0006, a total deadline of `--timeout-ms` (default 3,000, bounds
1..60,000), and no retry, redirect following, or connection reuse.

**AE-DEPLOY-PROBE-03 — Classification.**

| Expectation | Healthy when | Unhealthy otherwise |
| --- | --- | --- |
| `alive` | The endpoint answers with either HTTP 401 carrying a `Bearer` challenge, or a valid HTTP 200 `initialize` result. | Connection failure, timeout, 403, 404, 5xx, or a malformed protocol response. |
| `ready` | A valid HTTP 200 `initialize` result, using the bearer token from `--bearer-env` when given. | Everything else, including 401. |

`alive` deliberately accepts the authentication challenge: it proves the
adapter's boundary is serving without requiring the probe to hold a
credential. A 403 is never healthy because it indicates a Host or Origin
misconfiguration that would also reject real clients.

**AE-DEPLOY-PROBE-04 — Secret hygiene.** Credentials enter only through an
environment variable name. The token value never appears in argv, output,
diagnostics, or error causes; an `Authorization` header is redacted from any
reported request detail.

## Deployment topology guidance

`deploy/DEPLOYMENT.md` MUST state, and operators MUST follow:

- The engine terminates HTTP only. A TLS-terminating edge (reverse proxy,
  load balancer, or ingress) MUST front any non-loopback deployment, and the
  public URL MUST be HTTPS with the exact `/mcp` path.
- The adapter validates the raw `Host` header and ignores forwarded-host
  headers. The edge MUST forward the original public `Host`, and
  `AI_ENGINE_HTTP_ALLOWED_HOSTS` MUST list every public host it forwards.
- `AI_ENGINE_HTTP_ALLOWED_ORIGINS` is needed only for browser-based clients
  and MUST list exact origins.
- The profile is stateless (ADR 0007): replicas can scale horizontally with
  no sticky sessions, shared state, or drain coordination beyond the
  graceful-shutdown grace period.
- Capability authorization failures are MCP tool errors inside HTTP 200; edge
  monitoring MUST NOT treat them as transport failures.

## Errors and diagnostics

Errors are toolkit errors, not `EngineError` values. The stable code and
message are the public contract.

| Code | Stable message | Exit code |
| --- | --- | --- |
| `MANIFEST_NOT_FOUND` | `The deployment manifest was not found.` | `2` |
| `MANIFEST_INVALID` | `The deployment manifest is invalid.` | `2` |
| `PACKAGE_JSON_INVALID` | `The project package.json is missing required fields.` | `1` |
| `LOCKFILE_MISSING` | `No supported lockfile was found.` | `1` |
| `LOCKFILE_AMBIGUOUS` | `More than one lockfile was found.` | `1` |
| `ENTRY_NOT_BUILT` | `The HTTP entry module has not been built.` | `1` |
| `GENERATED_FILE_CONFLICT` | `An existing file is not managed by the toolkit.` | `1` |
| `WRITE_FAILED` | `A deployment file could not be written.` | `1` |
| `PROBE_UNREACHABLE` | `The MCP endpoint could not be reached.` | `1` |
| `PROBE_UNHEALTHY` | `The MCP endpoint is not healthy.` | `1` |

Diagnostics may include the file path, JSON pointer, expected marker, probe
URL, and HTTP status. They MUST NOT include environment values, header
values, response bodies, stack traces, or cause chains.

## Limits and operational behavior

| Dimension | Rule |
| --- | --- |
| Manifest size | 65,536 bytes encoded |
| Declared environment names | 64 |
| Generated files per `package` run | Exactly 4 |
| Child processes | 0 |
| Network operations | 0 for `init` and `package`; exactly 1 request per `probe` |
| Probe timeout | Default 3,000 ms; bounds 1..60,000 ms |
| Probe retries and redirects | 0 |
| File writes | Atomic temp-and-rename, UTF-8, LF, trailing newline |

File reporting order is lexicographic by path. Manifest issue order is JSON
pointer. These orders MUST be stable across runs with identical inputs.

## Versioning and compatibility

- Adding `@ai-engine/deploy` is additive and post-v0.1, but it requires the
  package-boundary ADR described above.
- Manifest `schemaVersion: 1` is exact. Because the schema is closed, adding
  even an optional field is a schema change requiring a release decision.
- The generated file marker carries the toolkit major version. A major
  version that changes generated content still overwrites marked files;
  authors review the diff like any dependency update.
- The environment contract is a public convention once released. Renaming a
  variable is breaking for every deployed engine and requires a major
  decision with a documented migration.
- Changes to `serveMcpHttp` options remain governed by the runtime packages;
  the scaffold tracks them in ordinary releases.

## Acceptance criteria

| ID | Observable outcome | Minimum evidence |
| --- | --- | --- |
| `AE-DEPLOY-AC-01` | `init` in an empty engine project writes the manifest and both source scaffolds; rerunning it reports every target as `skipped` and writes nothing. | Filesystem fixture with writer spies. |
| `AE-DEPLOY-AC-02` | The scaffolded composition root builds against the public `@ai-engine/mcp` API and refuses to start until the authentication hook is implemented. | Compile-and-start test on a fixture engine. |
| `AE-DEPLOY-AC-03` | Every environment variable in the contract table is honored, the precedence of `AI_ENGINE_HTTP_PORT` over `PORT` holds, and each invalid value aborts startup. | Table-driven env fixture tests. |
| `AE-DEPLOY-AC-04` | `SIGTERM` closes the scaffolded server, aborts an in-flight request, and exits `0`. | Child-process signal test. |
| `AE-DEPLOY-AC-05` | `package` output is byte-identical across repeated runs and machines given identical inputs, and contains no timestamp, username, or absolute path. | Golden-file determinism test with content scanning. |
| `AE-DEPLOY-AC-06` | Each lockfile produces its documented install command in the Dockerfile; zero or multiple lockfiles fail with their stable codes before any write. | Lockfile matrix fixtures. |
| `AE-DEPLOY-AC-07` | An unmarked existing `Dockerfile` yields `GENERATED_FILE_CONFLICT`, is not modified, and does not block generation of the other files. | Conflict fixture with byte assertions. |
| `AE-DEPLOY-AC-08` | A byte-identical regeneration reports `unchanged` and performs no write; a manifest change updates only affected files. | Writer spies plus mtime assertions. |
| `AE-DEPLOY-AC-09` | `probe --expect alive` accepts a 401 Bearer challenge and a valid initialize result, and rejects 403, 404, 5xx, malformed responses, and timeouts, within the deadline and with exactly one request. | Stub HTTP server matrix with request counting. |
| `AE-DEPLOY-AC-10` | `probe --expect ready` succeeds against required-auth `serveMcpHttp` only when the bearer variable holds a valid token, and the token value never appears in any output or error. | Integration test against a real adapter with a secret sentinel. |
| `AE-DEPLOY-AC-11` | The generated health-check script runs with Node built-ins only and sends the configured public `Host` header while connecting to loopback. | Script execution test against a Host-validating stub. |
| `AE-DEPLOY-AC-12` | A container built from a packaged fixture engine starts as non-root, reports healthy via the embedded health check, and serves an authenticated MCP `initialize` on the exposed port. | One gated end-to-end container smoke test, excluded from environments without a container runtime. |
| `AE-DEPLOY-AC-13` | Source inspection and runtime sentinels prove the toolkit spawns no process, imports no framework package, and opens no connection outside an explicit probe. | Import-graph check plus child-process and network sentinels. |
| `AE-DEPLOY-AC-14` | Manifest unknown keys, bad entry paths, invalid env names, size limits, and port bounds each fail deterministically with JSON-pointer diagnostics and no value echo. | Table-driven boundary tests. |

## Traceability

| Requirement | Contract surface | Acceptance evidence |
| --- | --- | --- |
| Production-shaped composition root | Scaffold, env contract, fail-closed auth, shutdown | `AE-DEPLOY-AC-01` through `AE-DEPLOY-AC-04` |
| Standardized configuration | Environment contract table | `AE-DEPLOY-AC-03`, `AE-DEPLOY-AC-05` |
| Deterministic deployment package | Manifest, generation order, marker policy, Dockerfile contract | `AE-DEPLOY-AC-05` through `AE-DEPLOY-AC-08`, `AE-DEPLOY-AC-14` |
| Verifiable deployments | Probe semantics, health-check script | `AE-DEPLOY-AC-09` through `AE-DEPLOY-AC-12` |
| Secret and execution safety | No child processes, bounded network, credential hygiene | `AE-DEPLOY-AC-10`, `AE-DEPLOY-AC-13` |
| Existing architecture unchanged | Standalone package, public-API-only generated code | `AE-DEPLOY-AC-02`, `AE-DEPLOY-AC-13`, package dependency review |

## Delivery slices

Implementation follows ADR 0008. Each slice begins with failing executable
evidence, ends green, and is one cohesive commit:

1. Record the package and architectural boundary in a new ADR, including the
   relationship with ADRs 0004, 0007, 0009, and 0010.
2. Add the `@ai-engine/deploy` package skeleton, injectable filesystem and
   clock boundaries, stable errors, and CLI usage behavior.
3. Add the closed manifest schema, limits, and deterministic diagnostics.
4. Implement `init` scaffolding, including the environment contract and
   fail-closed authentication scaffold, with compile-level evidence.
5. Implement `package`: lockfile detection, marker policy, atomic writes,
   and the Dockerfile, dockerignore, and DEPLOYMENT.md generators.
6. Implement the probe semantics as a shared module, then the `probe`
   command and the generated health-check script over it.
7. Add the gated container smoke test, secret sentinels, execution-boundary
   sentinels, and user documentation.

## Decisions required before implementation

These points need explicit agreement in the authorizing ADR:

1. **Package boundary.** This draft prefers a new `@ai-engine/deploy` over
   extending `@ai-engine/tooling`, because packaging concerns (container
   conventions, probe network access) have a different release cadence and
   risk profile than the composition build gate, mirroring the reasoning
   that separated the installer in ADR 0010. The alternative — an
   `ai-engine deploy` subcommand family in tooling — would avoid a sixth
   package at the cost of widening tooling's authority.
2. **Bundle versus container-stage install.** This draft rebuilds inside the
   image from the lockfile instead of bundling with a JavaScript bundler.
   Bundling would shrink images but adds a heavy dependency, breaks native
   modules, and makes output non-reviewable. Confirm or revisit.
3. **Scaffold ownership.** `init` writes into `src/`, which the toolkit then
   never manages again. Confirm that scaffolded source is user-owned from
   the first write, with no drift tracking.
4. **Health semantics.** Confirm that accepting a 401 challenge as `alive`
   is the intended liveness contract, and that no in-adapter health route
   will be added to `@ai-engine/mcp`.

## Deferred and unspecified

The following require later evidence and an explicit specification update:

- workspace and monorepo build contexts, including this repository's own
  examples with workspace-linked packages;
- Compose, Kubernetes, Terraform, or provider-specific manifests;
- image building, pushing, signing, SBOM generation, and vulnerability
  scanning;
- an in-adapter health or metrics endpoint, and any stateful HTTP profile;
- stdio MCP packaging and multi-engine images;
- secrets-manager integration and OAuth-protected probe credentials;
- machine-readable (`--json`) command output;
- a `watch` or development-server mode;
- a unified `ai-engine` launcher shared with tooling or the installer;
- automatic registration of a deployed endpoint in the local capability MCP
  installer registry.
