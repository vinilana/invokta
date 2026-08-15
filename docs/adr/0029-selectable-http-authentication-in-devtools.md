# ADR 0029: Selectable HTTP authentication in the engine devtools

- Status: Accepted
- Date: 2026-08-13

## Context

ADR 0028 made the devtools playground adapter-parameterized: one set of
arguments reaches the engine through a direct call, the CLI adapter, MCP stdio,
or MCP HTTP. The identity surface did not follow. The interface presents one
global control — `Act as <principal>` with a session-token status — as though
every path authenticated the same way, and a development principal with a
minted bearer token is demanded before any invocation.

That contradicts the framework's own contracts. Only the HTTP boundary
authenticates: it runs a hook per request and maps a credential onto a
`Principal`. The CLI adapter, MCP stdio, and a direct call receive the principal
from the composition root when the process starts; no credential exists and no
authentication step runs. Presenting a token status for those three paths
describes a ceremony that does not happen, and refusing to invoke without one
blocks three paths for a reason that applies to a fourth.

The authentication that does happen is also narrower than what an engine
publishes. In `serve` mode the devtools hosts the engine module itself with a
devtools-owned hook that accepts its own minted tokens (ADR 0021), so the
authentication an author actually ships — the hook in their own HTTP entry
point, verifying a JWT, an API key, or an OAuth access token — is never
exercised. The repository ships ten `examples/auth-*` engines whose entire
subject is that hook, and none of them can be observed from the playground.

## Decision

The devtools playground separates **identity** from **authentication**.

Identity is the development `Principal` an emulated call acts as. It applies to
every adapter, is selected next to the adapter switch, and includes an explicit
anonymous choice so an `access` rule can be denied deliberately on any path.
The global `Act as` control is removed; identity is presented where the
execution path is chosen, because that is where it takes effect.

Authentication is presented only for MCP HTTP, and only as far as it is real.
The MCP HTTP adapter gains a target:

- The **devtools host** — the loopback host `serve` already runs — remains the
  default. Its authentication is the devtools-owned hook, so the selectable
  types are the session token minted for the selected identity, or none, which
  exercises the adapter's own fail-closed challenge.
- An **external endpoint** is an MCP Streamable HTTP URL the developer runs
  themselves, typically their own built HTTP entry point. Its authentication is
  whatever that server implements, so the selectable types are none, bearer,
  custom headers, and interactive OAuth. The devtools identity does not apply:
  the principal comes from that server's own hook.

An external endpoint is reached through the public `@invokta/mcp` client facade,
which already refuses a URL that is neither HTTPS nor literal loopback, carries
credentials, or contains a query or fragment. None, bearer, and custom headers
connect per call and close with it, keeping the per-invocation process model of
ADR 0028. OAuth is inherently a session, so it reuses the ephemeral
Authorization Code with PKCE flow accepted by ADR 0023, including its loopback
callback, its refusal of a cross-origin identity provider, and its rejection of
a preconfigured client ID or secret.

Credentials are development-scoped by construction. A bearer token, a custom
header value, and every OAuth artifact live in the dev-server process memory
for the life of the target selection; a value may also be named as an
environment variable the dev server reads, matching how `verify` keeps a
credential out of an argument vector. Nothing is persisted, written to the
developer's project, or echoed back: reading the target returns its kind, its
URL, its authentication type, and header or variable names only.

The prohibitions of ADR 0021 and ADR 0028 continue to bind, and this decision
adds three. The devtools MUST NOT authenticate an emulated call for an adapter
that establishes no credential; MUST NOT persist, echo, or log a credential;
and MUST NOT accept an external endpoint the MCP client facade refuses. An
external endpoint is an invocation target only: the capability catalog, the
schemas, the doctor report, and the trace continue to describe the loaded
engine module.

## Consequences

- Three of the four paths become invocable without any credential ceremony,
  which is what the framework already specifies for them.
- The authentication an author ships can be exercised from the playground
  against the same arguments the other three paths use, which is the comparison
  the paths exist to support.
- A target that serves a different engine than the loaded module will fail on
  an unknown tool name; the devtools reports that rather than reconciling two
  catalogs.
- The dev server now makes outbound connections in workspace mode. It binds
  loopback only, as before.
- Extending this to a credential store, a second concurrent target, or
  authentication for a non-HTTP adapter requires another architectural
  decision.
