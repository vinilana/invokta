# Action Engine management console specification

- Status: Accepted, delivered on Linux and macOS; Windows unverified on a host
- Date: 2026-08-01
- Affected packages: `@invokta/installer-core` (new), `@invokta/installer`,
  `@invokta/manager` (new)
- Affected requirements: `AE-INSTALL-01..05`
- Architecture decision: [ADR 0019](../adr/0019-management-console-and-installer-core.md)

## Summary

This specification extracts the installer's configuration engine into
`@invokta/installer-core`, adds `@invokta/manager` as a loopback web console
over that core, and defines a Windows path-safety contract so all three
supported platforms can inspect and mutate client configuration.

The console replaces the terminal confirmation with a local session capability.
The installer executable keeps its existing grammar, diagnostics, exit codes,
and TTY confirmation without change.

## Goals

- Give an operator one view of every managed Action Engine, the clients each one
  is registered in, and the clients each one could be registered in.
- Let that operator install, enable, disable, and remove without a terminal
  interaction, on Linux, macOS, and Windows.
- Keep exactly one implementation of detection, ownership, transactions, and
  format-preserving configuration edits.
- Preserve every existing installer guarantee: fail-closed ownership, per-target
  transactions, atomic commits, rollback, bounded locks, and secret-free
  diagnostics.

## Non-goals

- Binding any interface other than loopback, or any form of remote access.
- Authentication providers, multi-user sessions, or sessions that outlive the
  console process.
- Managing MCP servers the installer does not own.
- Project, profile, workspace, or organization configuration scopes.
- Remote discovery, package acquisition, engine execution, or a mutable registry.
- Replacing the installer's interactive terminal flows.

## Public contract

### AE-CORE-01 — Core package surface

`@invokta/installer-core` MUST export the detection snapshot, the finite target
catalog, the configuration target adapters, the registry and engine-manifest
loaders, path identity, ownership planning, installer state, the installer lock,
the transaction coordinator, and the stable `InstallerError` code set.

It MUST NOT import `@invokta/core`, `@invokta/cli`, `@invokta/mcp`,
`@invokta/tooling`, or `@invokta/deploy`, and MUST NOT import
`node:child_process`, `node:dns`, `node:http`, `node:https`, `node:net`, or
`node:tls`. The existing filesystem, network, process-execution, and
engine-import sentinels move to this package unchanged in strength.

The state file location, state schema version `1`, target contract versions,
adapter formats, fingerprints, and stable diagnostic codes are unchanged. A
state file written by `@invokta/installer` `0.3.0` MUST remain readable and
writable.

### AE-CORE-02 — Installer adapter

`@invokta/installer` MUST keep `"exports": {}`, the `invokta-installer`
executable, and its documented command grammar, prompts, stable diagnostics, and
exit statuses. It MUST depend on `@invokta/installer-core` and contain no
duplicate detection, adapter, ownership, state, or transaction logic.

Its package boundary test MUST continue to prove that the executable is the only
published entry point.

### AE-CORE-03 — Machine-readable inventory and scoped operations

The core MUST expose two operations the console and the executable both use:

1. an inventory that returns, for every known engine identity, its persisted
   launch descriptor, its per-target ownership status, and, for every target
   where it is absent, whether installation is currently possible and the stable
   reason when it is not; and
2. target-scoped `install`, `enable`, `disable`, and `remove` that accept an
   explicit engine identity and an explicit target set.

Neither operation prompts. Confirmation is the caller's responsibility.

### AE-PLATFORM-01 — Named path-safety contracts

Path safety MUST be selected by platform and named in every result.

`posix` (Linux, macOS) is the existing contract: no-follow opens, per-component
ownership by the current user, permission-bit enforcement, and same-directory
atomic replacement.

`windows` (Windows) MUST reject any path component that is a reparse point,
confine every configuration and state path to the resolved current user profile,
require same-volume atomic replacement, and MUST NOT claim file ownership
evidence. `process.getuid` being absent MUST NOT fail state loading under this
contract.

A `ManagedInstallation` records the contract that wrote it. A record written
under one contract MUST remain readable under the other, and ownership evidence
MUST NOT be compared across contracts. Diagnostics MUST identify the active
contract.

### AE-WINDOWS-01 — Windows configuration targets

Under the `windows` contract the target catalog MUST resolve the documented
Windows user-scope configuration path for every target it supports, including
the `%APPDATA%` locations for Claude Desktop and Visual Studio Code. A target
without a reviewed Windows path MUST report `TARGET_UNSUPPORTED` rather than
guessing a location.

### AE-CONSOLE-01 — Executable surface

`@invokta/manager` MUST publish exactly one executable, `invokta-manager`, whose
grammar is:

```text
invokta-manager [--port <number>] [--scan <directory>]... [--no-open]
invokta-manager --help
invokta-manager --version
```

Invalid usage returns exit status `2`. The console does not require a TTY.

### AE-CONSOLE-02 — Session capability and transport

On start the console MUST mint one cryptographically random 256-bit session
token, bind `127.0.0.1` only, and write the console URL containing that token to
standard output. The token MUST NOT be written to a file, an environment
variable, a process argument, or any log.

Every request other than the document request MUST present the token in an
`Authorization: Bearer` header, compared in constant time. The document request
accepts the token as a query parameter and MUST NOT return any inventory data.

The server MUST reject a request whose `Host` header is not one of its own
loopback names — `127.0.0.1`, `localhost`, or `[::1]`, each with its port —
whose `Origin` header is present and not the matching loopback origin, or whose
`Sec-Fetch-Site` header is present and is neither `same-origin` nor `none`. It MUST set no
cookies, send no CORS headers, and serve the page with a content security policy
that forbids every external origin. Responses MUST carry `Cache-Control:
no-store` and `X-Content-Type-Options: nosniff`.

The session ends when the process ends. There is no refresh, no persistence, and
no second session.

### AE-CONSOLE-03 — Read model

`GET /api/inventory` MUST return the engines known from installer state, the
engines discovered from `invokta.mcp.json` manifests under the configured scan
roots, the finite target catalog with detection evidence, and one cell per
engine and target. A cell is `managed` with its ownership status, `installable`,
`needs-build`, or `unavailable` with a stable reason.

Discovery is bounded by a fixed depth and directory budget and MUST report when
it was truncated. A manifest that fails to parse MUST be reported, never
silently dropped. The response MUST NOT contain environment values, credentials,
configuration bytes, or the session token.

### AE-CONSOLE-04 — Mutations

`POST /api/action` accepts an action, an engine identity, and an explicit target
list. The console MUST require an in-page confirmation that states the action,
every affected client, and the exact command or endpoint being written, and MUST
NOT send the request before that confirmation.

Installing an engine that has a project on disk MUST re-resolve its descriptor
through the core's manifest loader, so manifest, path, and entry-point
validation decide what is written. Enable, disable, and remove MUST use the
persisted launch descriptor of the matching state record and MUST NOT
reconstruct it from a manifest or registry.

Each target remains one independent transaction under `AE-INSTALL-04`. The
response MUST report one payload-free result per requested target, identifying
`installed`, `enabled`, `disabled`, `removed`, `unchanged`, or `failed` with a
stable installer code.

### AE-CONSOLE-05 — Concurrency and failure

The console MUST serialize its own mutations and MUST hold the core's existing
state and target locks for each transaction, so a concurrent `invokta-installer`
run cannot interleave. A failed target MUST NOT roll back a target that already
committed, and the operation MUST be safe to repeat.

A request that arrives while another mutation is in flight MUST be rejected with
a stable conflict result rather than queued indefinitely.

### AE-CONSOLE-06 — Isolation

The console MUST NOT import or execute an engine, start an MCP transport, invoke
a capability, open an outbound connection, or read an environment value into a
response. Opening a browser is the only permitted process execution, it is
best-effort, and its failure MUST NOT affect the console.

Every value rendered into the page that originates from disk MUST be escaped.
Diagnostics MUST NOT contain configuration bytes, environment values,
credentials, causes, or stacks.

## Acceptance criteria

Implementation follows RED, GREEN, REFACTOR. Every new executable behavior
requires failing tests first.

| ID | Binary acceptance outcome |
| --- | --- |
| `AC-01` | The full pre-extraction installer suite passes against the extracted core with no behavioral change, and installer CLI tests still prove the documented grammar, diagnostics, and exit statuses. |
| `AC-02` | Package boundary tests prove `@invokta/installer` publishes only its executable, `@invokta/installer-core` publishes only its import API, and neither imports a framework package or a network, process, or DNS module. |
| `AC-03` | A state file produced by `0.3.0` is read, mutated, and rewritten by the extracted core without migration. |
| `AC-04` | Inventory and target-scoped operations are covered directly, including the installable, needs-build, and unavailable classifications and their stable reasons. |
| `AC-05` | Contract selection is covered on both platforms: POSIX keeps every existing ownership rejection, and Windows rejects reparse points, rejects paths outside the user profile, and loads state with no `getuid`. |
| `AC-06` | Windows target resolution is proven for every supported target, and an unsupported target reports `TARGET_UNSUPPORTED` instead of a guessed path. |
| `AC-07` | Console CLI tests accept exactly the documented grammar and reject every other vector with exit status `2`. |
| `AC-08` | Transport tests prove rejection of a missing token, a wrong token, a foreign `Host`, a foreign `Origin`, and a cross-site `Sec-Fetch-Site`, and prove the document response carries no inventory data. |
| `AC-09` | A full lifecycle test installs, disables, enables, and removes through the HTTP surface against fixture clients, leaving every unrelated definition byte-identical. |
| `AC-10` | A declined confirmation and a second concurrent mutation each produce zero writes and the specified result. |
| `AC-11` | Console sentinels prove no engine import, no capability invocation, no outbound connection, and no environment value or path in a response body. |
| `AC-12` | A page test proves that manifest-supplied titles, descriptions, paths, and diagnostics are escaped. |
| `AC-13` | Typecheck, lint, formatting, unit, integration, build, and release-package verification gates pass for all three packages. |

## Traceability

Every row below is delivered coverage, except where noted. Real Windows
execution on a Windows host is the one outstanding item; the Windows contract is
covered by platform-injected tests only.

| Requirement | Required acceptance evidence |
| --- | --- |
| `AE-CORE-01` | `packages/installer-core/test/package-boundary.test.ts`, migrated sentinel suites |
| `AE-CORE-02` | `packages/installer/test/package-boundary.test.ts`, `cli-usage.test.ts`, `cli-child-process.test.ts` |
| `AE-CORE-03` | `packages/installer-core/test/engine-inventory.test.ts`, `packages/installer-core/test/engine-discovery.test.ts` |
| `AE-PLATFORM-01` | `packages/installer-core/test/path-contract.test.ts` plus the existing `path-identity` and `node-file-system` suites |
| `AE-WINDOWS-01` | `packages/installer-core/test/target-config-evidence.test.ts` |
| `AE-CONSOLE-01` | `packages/manager/test/cli-usage.test.ts` |
| `AE-CONSOLE-02` | `packages/manager/test/console-http.test.ts` |
| `AE-CONSOLE-03` | `packages/manager/test/console-http.test.ts` |
| `AE-CONSOLE-04` | `packages/manager/test/console-http.test.ts` |
| `AE-CONSOLE-05` | `packages/manager/test/console-http.test.ts` |
| `AE-CONSOLE-06` | `packages/manager/test/console-isolation.test.ts`, `packages/manager/test/console-page.test.ts` |

## Compatibility impact

| Surface | Impact |
| --- | --- |
| `invokta-installer` grammar, diagnostics, exit codes | None |
| `@invokta/installer` package contract | None; still executable-only |
| Installer state schema | Additive: records carry the contract that wrote them; version `1` stays readable both ways |
| Target configuration formats | None |
| New packages | `@invokta/installer-core`, `@invokta/manager` |
| Platform support | Additive: Windows gains inspection and mutation under a named, weaker contract |
| Architecture requirements | Intentional revision: ADR 0010's no-programmatic-API rule now scopes to the installer application; ADR 0013's TTY requirement scopes to the installer executable |
| Runtime packages and `EngineError` | None |
| CLI/MCP invocation path | None |
