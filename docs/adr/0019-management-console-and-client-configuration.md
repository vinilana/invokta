# ADR 0019: Local management console and client configuration extraction

- Status: Accepted
- Date: 2026-08-01

## Context

ADR 0010 made `@invokta/installer` a binary-only application with no public
programmatic mutation API, and ADR 0013 required stdin and stdout TTYs for every
interactive operation. Both boundaries assumed one operator, one engine, and one
client at a time.

That assumption no longer matches how the framework is used. A machine now
carries several Action Engines across up to eleven configuration targets. The
installer can report that inventory only as a linear terminal listing, offers no
view of where an engine *could* be installed, and requires a separate
interactive selection for every single change. There is also no supported way to
manage engines without a terminal at all.

Two further boundaries block a graphical local console. The installer's package
contract forbids importing it, so any second front end would have to duplicate
eleven client adapters, four configuration formats, the ownership model, and the
transaction coordinator. And the installer's safety contract is expressed in
POSIX primitives — `O_NOFOLLOW`, `uid` and `gid` ownership, and permission bits
— so it refuses to run on Windows at all, including read-only inspection.

## Decision

### Core extraction

`@invokta/client-config` becomes the package that owns harness detection, the
finite target catalog, the format-preserving configuration adapters, the
registry and manifest contracts, path identity, ownership planning, installer
state, locking, and the transaction coordinator. It publishes a typed import
API and keeps the boundary ADR 0010 established for that logic: no remote
discovery, no package loading, no reflection, no shell execution, no capability
execution, and no network connection.

`@invokta/installer` keeps the `invokta-installer` executable, its interactive
terminal experience, and `"exports": {}`. It becomes a thin adapter over the
core. Its command grammar, stable diagnostics, exit codes, and confirmation
behavior are unchanged.

The prohibition ADR 0010 placed on a programmatic mutation API is revised: it
applied to the installer *application*, and it now applies to that application
only. The extracted core exposes the API deliberately, to one additional
reviewed front end rather than to arbitrary callers.

### Management console

`@invokta/console` publishes `invokta-console`, a local web console over the
core. It is the only package in the repository permitted to open a listening
socket, and it listens on the loopback interface only. It performs no remote
discovery, downloads nothing, and never becomes part of a capability call graph.

### Authorization boundary

Authorization moves from a TTY confirmation to a **local session capability**.
The console process mints one 256-bit session token per run and prints it, as
part of the console URL, to the stream that started it. Possession of that token
is the authorization. The session ends with the process.

Every request must carry the token in an `Authorization` header; the token in
the initial URL authorizes only the document. The server binds `127.0.0.1`,
pins the `Host` and `Origin` headers to its own address, rejects cross-site
`Sec-Fetch-Site` values, sets no cookies, sends no CORS headers, and serves one
page under a restrictive content security policy. A mutation additionally
passes through an explicit in-page confirmation that states the exact definition
being written.

That dialog is a guard against an operator mistake, not a second authorization.
The server enforces the session key and nothing else, so anything already
holding the key reaches the mutation endpoint without it. Making the dialog a
real boundary would require a server-issued confirmation nonce, which this
decision does not adopt.

This is weaker than a TTY confirmation against an attacker who can already read
the operator's terminal output or process table, and stronger against an
operator mistake, because the confirmation states the complete change. Both the
installer's TTY confirmation and the console's session capability remain
supported; neither replaces the other.

### Platform contracts

Path safety is expressed as two named contracts rather than one.

The **POSIX contract** on Linux and macOS is unchanged: open without following
symbolic links, prove that every path component is owned by the current user,
enforce permission bits, and replace atomically in the same directory.

The **Windows contract** is explicitly weaker, because Node exposes neither
`FILE_FLAG_OPEN_REPARSE_POINT` nor access control lists. It rejects reparse
points found by inspecting each path component, confines every configuration and
state path to the current user profile, and replaces atomically on the same
volume. It proves no file ownership and it is therefore vulnerable to a
same-machine attacker who can already write inside the user profile. That
attacker can already edit the client configuration directly, so the contract
does not widen the practical exposure; it does mean Windows never claims the
ownership guarantee the POSIX contract makes.

The active contract is carried on every path root it produces and selects the
checks applied beneath it. A state file written under one contract remains
readable under the other; ownership evidence is contract-scoped and is never
compared across platforms.

Surfacing the contract in diagnostics, state records, and public results is
adopted as the target and is **not implemented**: a consumer cannot currently
tell which contract produced a given piece of evidence.

## Consequences

- One implementation of client configuration safety serves the terminal and the
  console. A new front end costs an adapter, not a reimplementation.
- The installer's package boundary test moves with the logic: the sentinels that
  prove no network access, no process execution, and no engine import now guard
  the core, and the console is verified separately to open only a loopback
  socket.
- `@invokta/client-config` becomes a compatibility surface. Its exported types,
  installer state schema, target contracts, and stable diagnostics are versioned
  with the framework.
- Windows gains inspection and mutation with a documented, lower assurance
  level. Presenting Windows evidence as equivalent to POSIX evidence is a defect,
  and until the contract is carried in results the code cannot prevent it — the
  obligation sits with whoever reads the evidence.
- Windows containment has no exception, so a roaming profile redirected outside
  the user profile — Folder Redirection to a share — is reported unsafe rather
  than written to. Those deployments are unsupported by design.
- A machine-readable inventory and target-scoped operations become part of the
  core contract, so the terminal can adopt them without another decision.
- Publishing a console does not authorize remote access. Binding any interface
  other than loopback, adding an authentication provider, or persisting a
  session across processes requires a separate architectural decision.
