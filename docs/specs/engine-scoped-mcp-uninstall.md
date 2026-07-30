# Engine-scoped MCP uninstall specification

- Status: Proposed
- Date: 2026-07-30
- Affected packages: `@invokta/installer`, `create-invokta-engine`
- Affected requirements: `AE-INSTALL-01..05`

## Summary

Generated Action Engines expose `mcp:install`, but they do not expose the
inverse project-local workflow. The installer can remove one interactively
selected managed entry, but that global management command does not identify an
engine identity and does not remove that logical engine from every client in
which it is managed.

This specification adds an engine-scoped overload to the existing `remove`
command and a generated `mcp:uninstall` package script. It removes only
installer-owned registrations for the manifest identity, remains interactive,
and preserves the existing per-target transaction and fail-closed ownership
boundaries.

## Goals

- Give every newly generated engine symmetric `mcp:install` and
  `mcp:uninstall` package scripts.
- Let an engine author remove that engine from every supported user-scope MCP
  client through one confirmed operation.
- Allow cleanup after the compiled MCP entry point has been deleted.
- Preserve exact ownership checks, target isolation, deterministic partial
  results, and idempotent retries.

## Non-goals

- Removing an arbitrary or unowned MCP server definition.
- Deleting the engine project, dependencies, build output, credentials, a
  client configuration file, or the installer state file.
- Adding non-interactive confirmation bypasses, project or profile scope,
  Windows configuration mutation, remote discovery, package execution, or
  network access.
- Replacing the existing `invokta-installer remove` flow for selecting one
  managed target.
- Adding an engine or capability execution path.
- Proving project provenance beyond the manifest `id`, or allowing distinct
  logical engines to share one `id`.

## Public contract

### AE-UNINSTALL-01 — Generated project surface

`create-invokta-engine` MUST add this exact script to every newly generated
project:

```json
{
  "scripts": {
    "mcp:install": "tsc -p tsconfig.json --pretty false && invokta-installer install --engine .",
    "mcp:uninstall": "invokta-installer remove --engine ."
  }
}
```

`mcp:install` remains build-first. `mcp:uninstall` MUST NOT build the engine or
require the compiled MCP entry point, the recorded Node executable, forwarded
environment variables, or an installed client executable. The installer binary
and the project manifest must still be available.

The generated README MUST document the package-manager-specific install and
uninstall invocations. Existing generated projects are not modified in place;
their owners MAY add the script manually after upgrading `@invokta/installer`.

### AE-UNINSTALL-02 — Installer command surface

The additive command grammar is:

```text
invokta-installer remove --engine <project-directory>
```

The vector has exactly three arguments. A missing directory, an extra argument,
a repeated option, an option before `remove`, or a mix with another command is
invalid usage. Invalid usage returns exit status `2` and does not load the
interactive application.

The existing argument-free `invokta-installer remove` command retains its
current one-installation selection behavior. The new overload requires stdin
and stdout TTYs and uses the existing `NO_TTY` diagnostic and exit status `2`
when either is unavailable.

### AE-UNINSTALL-03 — Project source and identity

The command MUST resolve the explicit project directory and read its single
`invokta.mcp.json` file through the local-engine no-follow and current-user
ownership boundary. It MUST apply the existing 1 MiB strict UTF-8 JSON limit,
duplicate-key prohibition, closed schema-version-one shape, string and count
limits, and relative entry-point syntax validation.

Removal validates manifest metadata but MUST NOT require the entry-point path to
exist or resolve the entry point to a regular file. `ENGINE_MANIFEST_INVALID`
and `ENGINE_PATH_UNSAFE` retain their existing meanings. An absent compiled
entry point MUST NOT produce `ENGINE_ENTRYPOINT_MISSING` during removal.

The manifest `id` is the stable, installer-global logical engine identity. A
removal matches state records whose `entryId` equals that `id`, independent of
manifest version, title, description, capability IDs, current server name,
project location, or current entry-point path. The command MUST use each matched
state's persisted launch descriptor and server name for inspection and removal;
it MUST NOT reconstruct the installed definition from the current manifest.

Every manifest with the same `id` selects the same logical engine for installer
management. A copied manifest or a distinct project that reuses an `id` therefore
has the same removal authority after current-user path validation and explicit
confirmation. Project paths and mutable manifest metadata are not provenance.
Authors MUST assign a different `id` to every distinct logical engine. This
feature does not add a project-origin field or change installer state schema
version `1`.

The identity namespace is shared by bundled, local-engine, and direct-remote
install sources. Reusing an `id` across source kinds intentionally denotes the
same logical engine and puts all records with that `entryId` in removal scope.
Because state schema version `1` does not persist source kind, removal MUST NOT
infer project provenance from a transport, command, URL, or historical path.

Changing `id` creates a different engine identity. Before confirmation or any
write, the command MUST scan all managed state records. If any record uses the
current manifest server name under another `entryId`, the complete operation
MUST fail closed with the new stable diagnostic below. This rule applies whether
or not exact-`id` matches also exist, so a mixed-identity state cannot produce a
partial mutation:

```text
ENGINE_IDENTITY_MISMATCH: The manifest does not match the managed Action Engine identity.
```

### AE-UNINSTALL-04 — Scope, preflight, and confirmation

The command MUST load the installer state and current finite target catalog,
then consider every managed state record matching the engine ID. State
validation guarantees at most one matching record per target. Matching records
are ordered by the catalog's stable target order, including catalog targets that
are unavailable on the current platform. Removal eligibility comes from a
matching managed record, the current supported target contract, a safe
configuration path, and exact ownership evidence; it MUST NOT depend on client
executable evidence, engine runtime availability, or environment variable
values.

Global preflight gates run in this order after the CLI TTY check: validate the
project source, detect the finite target catalog and load valid state, then scan
for an identity mismatch. A global gate failure emits its stable diagnostic,
returns `1`, requests no confirmation, emits no per-target result, and performs
no write. Per-target blocked evidence is not a global target-detection failure;
it is included in the summary after all global gates succeed.

The preflight summary MUST identify every matching client and whether its entry
is removable or blocked. All removable matches are in scope; the engine-scoped
flow does not present a target multiselect. One explicit confirmation authorizes
the complete ordered set of removable per-target transactions. No target or
state mutation may occur before that confirmation.

If the user declines confirmation, the command returns `0` without mutation. If
the user cancels a prompt, it returns `130` and uses the existing `CANCELLED`
diagnostic. If no matching record and no identity mismatch exists, the engine is
already uninstalled: the command reports an idempotent no-op, returns `0`, does
not request confirmation, and performs no write. If matching records exist but
none is removable, the command reports every blocked result, returns `1`, does
not request confirmation, and performs no write.

### AE-UNINSTALL-05 — Ownership and failure behavior

A target is removable only when the current definition is still the exact
installer-owned definition represented by its ownership record. Enabled,
natively disabled, detached-disabled, and outdated managed definitions are
eligible when their existing ownership checks succeed.

The command MUST fail closed for drift, a server-name conflict, an unsafe or
relocated configuration path, invalid or unavailable state metadata, an
unsupported current target contract, or unavailable legacy descriptor metadata.
It MUST reuse the applicable existing installer codes, including
`CONFIG_DRIFT`, `CONFIG_CONFLICT`, `HARNESS_CONFIG_UNSAFE`, `STATE_INVALID`,
`TARGET_UNSUPPORTED`, and `INSTALLATION_UNAVAILABLE`. A blocked target MUST NOT
prevent an independent removable target from being attempted after confirmation,
but it makes the final operation unsuccessful.

Every removable matching record MUST contain its persisted `launchDescriptor`.
A version-one legacy record without that field is blocked as
`INSTALLATION_UNAVAILABLE`, even if the bundled registry currently contains an
entry with the same `id`. The engine-scoped flow MUST NOT use the registry or the
current manifest to reconstruct missing ownership metadata.

Removal deletes only the owned server definition, including a natively disabled
definition, and its matching state record. A detached-disabled definition is
already absent from client configuration, so successful removal deletes only
its matching state record. The surrounding configuration and every unrelated
server definition MUST remain byte-preserved according to the target adapter's
existing format contract.

### AE-UNINSTALL-06 — Transactions, concurrency, and idempotency

Each target remains one independent transaction under `AE-INSTALL-04`. The
command processes targets sequentially in catalog order. Every target
transaction MUST:

1. acquire the shared state lock before the target configuration lock;
2. re-read and revalidate state, path identities, configuration, target
   contract, and ownership after locking;
3. atomically commit the configuration post-image when one is required;
4. atomically commit the state post-image; and
5. restore the exact configuration pre-image if the state commit fails.

A target failure does not roll back a target that already committed. The final
summary MUST expose one payload-free result per matching target. Public outcomes
are `removed`, `already absent`, or `failed` with a stable installer error code.

If another installer process removes both the managed record and definition
after preflight but before the locked revalidation, the target outcome is
`already absent`. If the record disappears while a matching definition remains,
ownership is no longer provable and removal fails as
`INSTALLATION_UNAVAILABLE`. Repeating a fully successful command returns `0`
without writes.

The final exit status is:

| Status | Meaning |
| --- | --- |
| `0` | Every matching target was removed or already absent, no match existed, or confirmation was declined |
| `1` | At least one matching target was blocked or failed |
| `2` | Usage, TTY, or initialization failed |
| `130` | The user cancelled a prompt |

The installer performs no automatic retry. The safe retry is to run the same
command again.

### AE-UNINSTALL-07 — Operational and architecture limits

The operation inherits the existing maximum of 11 current user-scope targets,
the 16 MiB installer-state limit, the 11,000-record state limit, target
configuration byte limits, bounded lock acquisition, safe temporary-file rules,
and same-directory atomic replacement behavior. It introduces no command-level
timeout; only lock acquisition remains explicitly time-bounded.

Prompt cancellation is supported before mutation authorization. After
confirmation, this feature adds no cooperative cancellation point inside a
target transaction. Process-termination recovery remains bounded by atomic
replacement, identity-owned locks, and the existing rollback contract.

The command MUST NOT read environment values, open a network connection, start
a process, import or reflect on the engine, start an MCP transport, invoke a
capability, or call `engine.invoke`. Diagnostics and summaries MAY contain the
manifest title, server name, target display name, outcome, and stable diagnostic
code. They MUST NOT contain configuration bytes, absolute paths, environment
values, credentials, causes, or stacks.

## Acceptance criteria

The implementation follows RED, GREEN, REFACTOR. All new executable behavior
requires failing tests before implementation.

| ID | Binary acceptance outcome |
| --- | --- |
| `AC-01` | CLI tests accept exactly `remove --engine <directory>`, include it in help, preserve argument-free `remove`, and reject every undocumented ordering or extra argument before interactive loading. |
| `AC-02` | Creator tests prove that every generated package contains the exact build-first `mcp:install` and build-free `mcp:uninstall` scripts and documents both package-manager commands. |
| `AC-03` | A packed-creator consumer installs the generated engine into fixture clients and then removes it through the generated `mcp:uninstall` script. |
| `AC-04` | Source tests accept a valid owned manifest when `dist/mcp-stdio.js` is absent and still reject an unsafe project path, malformed manifest, invalid entry-point syntax, oversized bytes, duplicate keys, and unknown fields. |
| `AC-05` | Identity tests match the persisted `entryId` across manifest version, metadata, location, server-name, entry-point, and install-source changes; prove that copied manifests with one `id` select one logical engine; and remove the persisted server definition rather than a definition reconstructed from the current manifest or registry. |
| `AC-06` | A same-server-name record with another `entryId` produces `ENGINE_IDENTITY_MISMATCH`, exit `1`, no confirmation, and zero writes both with and without exact-`id` matches. |
| `AC-07` | No matching state record returns `0`, makes no confirmation request, opens no write handle, and remains identical on repeated runs. |
| `AC-08` | Preflight lists all matching targets in catalog order; one confirmation covers all removable matches; declining or cancelling produces zero writes and the specified exit status; an all-blocked set returns `1` without confirmation. |
| `AC-09` | Enabled, natively disabled, detached-disabled, and outdated owned entries are removed without changing unrelated bytes; drifted, conflicting, unsafe, unsupported, or legacy-unavailable entries remain untouched with the required code, and legacy records never receive a registry fallback. |
| `AC-10` | A multi-target fixture proves deterministic partial completion: successful targets stay committed, failed targets stay unchanged, every target receives one result, and the final status is `1`. |
| `AC-11` | Concurrency tests revalidate after state/config locks; a concurrent complete removal becomes `already absent`, while a missing record with a remaining definition fails closed. |
| `AC-12` | State-commit failure restores the exact configuration pre-image; rollback failure remains separately reported with existing safe artifacts. |
| `AC-13` | Sentinels prove engine-scoped removal performs no process execution, network access, engine import, capability invocation, or environment-value read and emits no path, secret, configuration, cause, or stack. |
| `AC-14` | Installer, creator, documentation, packed-package, typecheck, lint, formatting, unit, integration, build, and release verification gates pass. |

## Traceability

No implementation evidence exists for the new behavior while this specification
is proposed. The listed files are the required acceptance locations, not claims
of completed coverage.

| Requirement | Contract | Required acceptance evidence |
| --- | --- | --- |
| `AE-UNINSTALL-01` | Generated scripts and documentation | `packages/create-invokta-engine/test/starter.test.ts`, packed creator smoke tests, docs site contract |
| `AE-UNINSTALL-02` | Exact additive CLI grammar and TTY boundary | `packages/installer/test/cli-usage.test.ts`, `packages/installer/test/cli-child-process.test.ts` |
| `AE-UNINSTALL-03` | Metadata-only manifest validation and stable engine ID | `packages/installer/test/engine-manifest.test.ts`, new engine-removal source tests |
| `AE-UNINSTALL-04` | Complete target scope and one confirmation | New engine-removal session tests and `packages/installer/test/interactive-session.test.ts` |
| `AE-UNINSTALL-05` | Exact ownership and fail-closed errors | New engine-removal session tests, `packages/installer/test/ownership-planner.test.ts`, target adapter inverse tests |
| `AE-UNINSTALL-06` | Ordered transactions, rollback, concurrency, and retry | `packages/installer/test/mutation-coordinator.test.ts`, transaction lock tests, new concurrent removal cases |
| `AE-UNINSTALL-07` | Limits, isolation, and secret-free diagnostics | Existing filesystem/network/process sentinels extended to engine-scoped removal |
| `AE-INSTALL-01,04,05` | Static-source, transaction, and execution boundaries remain unchanged | Full installer suite and release-package verification |
| `AE-INSTALL-02,03` | Confirmation is extended to an engine-wide target set, and removal no longer requires engine runtime availability | Accepted ADR, updated architecture contract, full installer suite, and release-package verification |

## Compatibility impact

| Surface | Impact |
| --- | --- |
| Installer CLI | Additive: `remove --engine <directory>`; argument-free `remove` is unchanged |
| Installer diagnostics | Additive: `ENGINE_IDENTITY_MISMATCH` |
| Installer state schema | None; schema version `1` remains readable and writable |
| Target configuration formats | None; existing adapters and ownership fingerprints remain authoritative |
| Generated projects | Additive for newly generated projects; existing projects are never rewritten |
| Architecture requirements | Intentional revision: `AE-INSTALL-03` no longer requires runtime availability for removal; its ownership and drift boundaries remain unchanged |
| Runtime packages and `EngineError` | None; installer codes remain outside capability execution |
| CLI/MCP invocation path | None; configured MCP tools continue to call only `engine.invoke` |

## Required architecture decision

This specification expands the installer's public CLI and the fixed generated
engine surface. Before implementation, the repository MUST record an accepted
ADR that adopts the engine-scoped removal boundary, stable manifest identity,
manifest-ID collision semantics, and build-free uninstall behavior. The same
deliverable MUST revise `AE-INSTALL-03` so runtime availability is not a removal
precondition. That ADR may extend ADRs 0012 and 0013; it must not copy delivery
chronology or the executable acceptance matrix into the ADR.

## Contract-review verdict

`APPROVED WITH CONDITIONS` for implementation planning. The operations, inputs,
outputs, effects, stable failure, idempotency, ordering, concurrency, limits,
compatibility, and architectural boundary are specified. Implementation remains
gated on the required ADR, RED tests for `AC-01..13`, and complete validation in
`AC-14`.
