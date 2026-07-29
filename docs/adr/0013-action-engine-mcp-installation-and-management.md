# ADR 0013: Action Engine MCP installation and management

- Status: Accepted
- Date: 2026-07-29

## Context

The standalone engine creator produces a working MCP stdio entry point, while
the installer already owns reviewed client configuration adapters and safety
primitives. The current public workflow does not connect those boundaries: the
creator asks the author to configure a client manually, the bundled installer
registry is empty, and the installer executable exposes only a read-only
inventory.

An engine author needs one local command to build an Action Engine and register
that exact MCP entry point with installed clients. The same configurator also
needs bounded management operations and a way to register an already deployed
stateless MCP HTTP endpoint without turning the installer into a package loader,
network discovery service, or capability executor.

## Decision

`@invokta/installer` remains a binary-only, standalone end-user application. It
adds interactive `install`, `status`, `enable`, `disable`, and `remove`
operations. The existing argument-free read-only inventory remains compatible.
Every interactive operation requires stdin and stdout TTYs. Exit status is `0`
for success or an idempotent result, `1` for an operational failure, `2` for
invalid usage or initialization, and `130` for cancellation.

The additive public command surface is:

```text
invokta-installer
invokta-installer install --engine <project-directory>
invokta-installer install --http <server-name> <url>
  [--bearer-token-env <NAME>] [--header-env <HEADER=NAME>]...
invokta-installer status
invokta-installer enable
invokta-installer disable
invokta-installer remove
invokta-installer --help
invokta-installer --version
```

Management commands select one eligible managed installation interactively and
perform at most one target transaction. Unknown, reordered, repeated, or mixed
source options are invalid usage. The new stable diagnostic codes are
`ENGINE_MANIFEST_INVALID`, `ENGINE_PATH_UNSAFE`, `ENGINE_ENTRYPOINT_MISSING`,
`REMOTE_INVALID`, and `INSTALLATION_UNAVAILABLE`; existing ownership,
configuration, state, runtime, locking, rollback, cancellation, and
initialization codes retain their meanings.

### Local engine source

A local engine installation reads one closed `invokta.mcp.json` manifest from an
explicit engine directory. Schema version `1` contains the registry identity,
display metadata, declared capability IDs, server name, project-relative MCP
stdio entry point, and names of environment variables to forward. The manifest
contains no command, absolute path, environment value, credential, or executable
code.

The manifest is strict UTF-8 JSON without a BOM or duplicate keys and is bounded
to 1 MiB. It has exactly these fields: `schemaVersion`, `id`, `version`, `title`,
`description`, `capabilityIds`, and `server`; `server` has exactly `name`,
`entrypoint`, and `forwardEnv`. It reuses the bundled registry's inclusive
identity, string, capability-count, environment-name, and server-name limits.
The entry point is a slash-separated relative path of at most 1,024 Unicode
scalars and 32 nonempty segments; `.`, `..`, empty segments, a leading slash,
backslash separators, NULs, and absolute paths are invalid.

The installer resolves the real engine directory, validates every manifest and
entry-point path component without following symbolic links, requires the built
entry point to be a regular file owned by the current user, and converts it to a
reviewed stdio launch descriptor. The descriptor uses the current absolute Node
executable and the absolute entry-point path. The installer never imports,
reflects on, or executes the engine. Moving or deleting the engine intentionally
invalidates that launch descriptor; `status` reports the missing command or
entry point, and a later install from the new location is an explicit update.

`create-invokta-engine` generates this manifest, adds
`@invokta/installer` as a development dependency, and adds `mcp:install`. The
script builds the project before invoking `invokta-installer install --engine .`.
A build failure therefore occurs before client detection, confirmation, or
configuration writes.

### Direct remote source

`install --http` accepts an explicit server name and canonical Streamable HTTP
URL plus optional environment-variable references for a bearer token and HTTP
headers. It performs no request. HTTPS is required except for canonical loopback
HTTP development URLs. Credentials, query strings, fragments, user information,
and non-`/mcp` paths are rejected. Only environment variable names are persisted;
their values are never read into configuration, state, or diagnostics.

### Selection and authority

Install detects a finite client catalog, filters it through each target's
compatibility function, preselects all eligible targets, and requires one
explicit confirmation before any write. A target with an existing safe user
configuration is eligible. Creating a missing user configuration additionally
requires installed-client evidence. The first management release owns only
default user-scope configurations; project, profile, remote-workspace, and
organization-managed scopes require later decisions.

The initial catalog contains the existing nine targets plus VS Code and Claude
Desktop. VS Code uses the default user profile on Linux and macOS. Claude Desktop
uses its documented macOS configuration and is unsupported on Linux. Windows
configuration mutation remains unsupported until the installer has an
equivalent no-follow ownership and atomic-write contract for that platform.

### Persistence and management

New managed installation records persist the normalized launch descriptor in
addition to ownership metadata. This contains command or URL structure and
environment variable names, never environment values. Existing version-one
state without a persisted descriptor remains readable; it can be managed only
when the bundled registry still supplies the matching descriptor.

`status` re-inspects every managed target and reports enabled, disabled,
outdated, drifted, unavailable, or missing-runtime state without mutation.
`enable` and `disable` operate only on an installation selected from state.
`remove` deletes the owned server definition, including a natively disabled
definition, and removes the corresponding state record. It never deletes an
unrelated configuration file or an externally changed definition. Drift and
name conflicts fail closed.

### Transaction boundary

Each selected client is one independent transaction. Multi-client installation
is deterministic but not globally atomic: a failure for one client does not
roll back already committed clients, and the final result identifies success
and failure per target. Re-running the command is idempotent.

For one target, the installer:

1. acquires the shared state lock and then the target configuration lock;
2. re-reads and revalidates state, path identities, configuration, runtime
   requirements, ownership, and the planned action;
3. writes and atomically renames the configuration post-image;
4. writes and atomically renames the state post-image; and
5. restores the exact configuration pre-image if the state commit fails.

Temporary files are exclusive, same-directory, bounded, flushed, and preserve
safe ownership and mode. Locks are bounded and identity-owned. A rollback
failure is reported separately and leaves artifacts for manual inspection. No
diagnostic includes configuration bytes, environment values, credentials,
causes, or stacks.

The configured client later starts `@invokta/mcp`; every tool call continues
through the engine's single `engine.invoke` path. Installer management never
enters the capability call graph.

## Consequences

- A generated engine gains one package-manager script for local MCP client
  installation without a new framework package or runtime abstraction.
- The local manifest, installer commands, target formats, stored launch
  descriptor, errors, exit codes, and user-scope defaults are compatibility
  surfaces.
- Persisting a launch descriptor enables offline management while preserving the
  installer prohibition on package loading, reflection, execution, and network
  access.
- Adding project scope, Windows mutation, remote discovery, package acquisition,
  or a mutable registry requires a separate architectural decision.
