# ADR 0040: Installer support for mounted MCP URLs

- Status: Accepted
- Date: 2026-09-05
- Evidence: [Issue #75](https://github.com/vinilana/invokta/issues/75)

## Context

ADR 0039 permits canonical MCP HTTP mount paths such as `/e/brain/mcp` and
extends deploy inspection to preserve them. ADR 0013's installer contract still
requires exactly `/mcp`. Consequently, a valid Gateway engine cannot be installed
with `install --http`: version 0.8.1 returns `REMOTE_INVALID` before any network
request. The same restriction also appears in registry parsing, persisted
installation state, and inverse target configuration conversion.

## Decision

The installer accepts the canonical mount-path grammar of ADR 0039 wherever it
reads or writes a remote MCP URL. The path MUST be absolute, contain only
nonempty unreserved ASCII segments, end in the exact segment `mcp`, and be at
most 256 bytes. Dot segments, percent encoding, backslashes, whitespace/control
characters, empty segments, query strings, fragments, and trailing slashes are
rejected. URL parsing MUST NOT normalize a noncanonical raw path into an accepted
one.

The complete path remains part of the resource identity in direct remote
sources, bundled registry entries, client configurations, launch descriptors,
and suspended descriptors. Registry, state, installation, and management use one
internal URL validator so they cannot disagree about mounted endpoints.

This extends the path restriction of ADR 0013 without changing its other rules.
HTTPS remains required except for literal `127.0.0.1` and `[::1]` HTTP URLs;
credentials and user information remain forbidden. `/mcp` remains valid.
CLI syntax, descriptor/state schema versions, diagnostic codes, environment
references, target compatibility, and explicit write confirmation are unchanged.

The installer remains an offline supporting package. It does not depend on
`@invokta/mcp` or `@invokta/deploy`, follow redirects, discover servers, authenticate
the caller, or invoke capabilities. The configured client completes OAuth when
it connects. The local path predicate implements the accepted contract without
adding a shared runtime abstraction or a new public export.

## Consequences

- Gateway engines can be installed and managed with their published resource URL.
- Existing default-path installations keep their identity and need no migration.
- Old installer versions still reject mounted endpoints; consumers need a build
  containing this change. Source-checkout validation is distinct from an npm release.
- Tests cover direct descriptors, registry/state validation, target conversion,
  path limits, alias rejection, and offline operation.
