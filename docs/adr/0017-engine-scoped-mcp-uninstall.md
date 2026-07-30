# ADR 0017: Engine-scoped MCP uninstall

- Status: Accepted
- Date: 2026-07-30

## Context

Generated Action Engines build and install their MCP stdio entry point through a
project-local command, but removing that logical engine still requires selecting
one managed target at a time through the global installer. Cleanup also stops
being convenient after the compiled entry point or recorded Node executable is
unavailable, even though removal authority comes from installer state and the
current client definition rather than from executing the engine.

The installer state schema already treats `entryId` as the identity shared by
bundled, local-engine, and direct-remote sources. It persists at most one record
per identity and target, including the launch descriptor and ownership
fingerprint needed to inspect and remove the exact managed definition.

## Decision

`@invokta/installer` adds the interactive command:

```text
invokta-installer remove --engine <project-directory>
```

The command validates the explicit project's closed `invokta.mcp.json` manifest
through the existing current-user, no-follow boundary without requiring the
compiled entry point. Its manifest `id` selects every state record with the same
`entryId` in the fixed user-scope target catalog. Identity is installer-global:
project paths, mutable manifest metadata, and source kind are not provenance,
and reusing an ID denotes the same logical engine.

Before mutation, a state record using the manifest's current server name under a
different identity fails the complete operation as
`ENGINE_IDENTITY_MISMATCH`. Records without a persisted launch descriptor remain
unavailable; the scoped flow does not reconstruct one from the manifest or
bundled registry.

The command preflights every matching target, reports removable and blocked
entries, and requires one confirmation for the ordered removable set. Each
target remains an independent state-lock-then-config-lock transaction with
locked revalidation, atomic configuration and state commits, exact rollback,
partial results, and idempotent retry. A blocked or failed target makes the final
exit status `1` without rolling back an independently committed target.

Removal does not require client executable evidence, the engine runtime,
launch or credential environment values, process execution, network access,
engine import, transport startup, or capability invocation. Existing installer
path-selection environment variables remain available for locating user
configuration and state. Removal uses only the persisted descriptor, current
target contract, safe configuration evidence, and exact ownership fingerprint.
The argument-free `remove` command retains its single-selection behavior.

`create-invokta-engine` adds the build-free package script
`mcp:uninstall = "invokta-installer remove --engine ."` and documents it beside
the existing build-first `mcp:install`. Generated projects remain user-owned and
are not rewritten in place.

## Consequences

- A generated engine has symmetric install and uninstall commands without a new
  package, state schema, target format, or execution path.
- The local manifest ID becomes explicit removal authority for all matching
  installer sources after current-user validation and interactive confirmation.
- Runtime availability is no longer a removal precondition; drift, conflicts,
  unsafe paths, unsupported targets, and unavailable ownership metadata still
  fail closed.
- Multi-target uninstall is deterministic but not globally atomic. Existing
  per-target locking, rollback, bounded resources, and secret-free diagnostics
  remain authoritative.
