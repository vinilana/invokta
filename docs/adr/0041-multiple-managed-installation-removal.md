# ADR 0041: Multiple managed installation removal

- Status: Accepted
- Date: 2026-09-05

## Context

An engine installed with `install --http brain <url>` can be registered in
several clients at once, but the argument-free `remove` command selects only
one installation. Removing it everywhere requires repeating the whole command.
The project-scoped removal from ADR 0017 requires a local manifest and does not
provide a selection of arbitrary managed installations.

## Decision

The existing interactive `invokta-installer remove` command selects one or more
managed installations with the shared multiselect prompt. A choice identifies
one persisted installation, including its engine and client. The operator may
select all eligible entries with the prompt's `A` shortcut. Nothing is
preselected; a review lists the exact engine/client pairs before one explicit
confirmation, which defaults to refusal.

Only enabled, disabled, or outdated entries with an available descriptor are
eligible, as before. Drifted, conflicting, unsafe, or unavailable entries never
become removal candidates. Submitted choices must belong to that inspected
candidate set. Unknown choices fail with `INSTALLATION_UNAVAILABLE` before
confirmation or mutation. Duplicate choices are deduplicated, and selected
entries execute in the existing inventory order regardless of selection order.
The existing 11,000-record state limit bounds the selection; no new input,
schema, limit, flag, or diagnostic code is introduced.

An empty submitted selection or refused confirmation is a no-op with exit
status `0`; cancellation before confirmation returns `130`. No write occurs
before confirmation. Each selected entry uses its own persisted descriptor and
the existing state-lock-then-config-lock coordinator. This also permits several
different engines in one client without losing another definition or state
record. Current ownership and configuration are revalidated under those locks.

Removal reports one result per selected engine/client pair and continues after
an individual failure. A failure returns exit status `1` without rolling back
independent successes. All-success and idempotent results return `0`. Existing
bounded locking, exact per-transaction rollback, secret-free diagnostics, and
offline execution remain authoritative. Removal does not resolve an engine
runtime, read credential values, or invoke capabilities.

This supersedes only the single-selection rule for argument-free removal in
ADRs 0013 and 0017. `enable`, `disable`, `status`, installation, and
`remove --engine <project-directory>` retain their behavior.

## Consequences

- Remote and local installations can be removed together with one review and
  confirmation while retaining each entry's ownership boundary.
- Multiple removals are ordered independent transactions, not a globally atomic
  batch. Failures remain visible and can be retried separately.
- The change is an extension of interactive selection. Existing command syntax,
  state, descriptors, target configuration formats, and package APIs stay
  compatible; no release version is changed by this feature slice.
