# ADR 0022: Ephemeral OAuth for installed MCP inspection

- Status: Accepted
- Date: 2026-08-06

## Context

ADR 0021 permits the installed-MCP workbench to connect to an explicit HTTP
target with no authentication, a supplied bearer token, or custom headers. It
deliberately excludes OAuth because an authorization redirect, callback, PKCE
state, token exchange, and credential lifecycle require a larger authority than
one static request header.

Remote MCP servers commonly publish OAuth Protected Resource Metadata and
expect an interactive MCP client to complete Authorization Code with PKCE.
Requiring a developer to obtain and paste an access token bypasses the launch
path being tested and makes authentication homologation incomplete.

The official MCP SDK already implements protected-resource discovery,
authorization-server discovery, dynamic client registration, PKCE, token
exchange, and authenticated Streamable HTTP requests. Reimplementing those
protocols in devtools would violate the SDK-isolation decision in ADR 0006.

## Decision

The installed-MCP workbench adds an `OAuth` authentication choice for an
explicit Streamable HTTP target. It implements only interactive Authorization
Code with PKCE through the approved official SDK inside `@invokta/mcp`.
Devtools remains an OAuth public client: it accepts no client secret and does
not implement device authorization, client credentials, private-key JWT,
password grants, or a provider-specific login flow.

OAuth is available only in the interactive workbench. The non-interactive
`verify` command remains limited to none, bearer, and custom-header
authentication supplied through environment variables. This preserves its
deterministic, unattended contract.

`@invokta/mcp` exposes a plain-type, two-step OAuth authorization handle. The
first step validates the explicit MCP URL and exact loopback callback URL,
performs bounded official discovery and registration, generates PKCE material,
and returns one validated authorization URL of at most 8,192 bytes. The second
step accepts the single-use authorization code and returns the existing plain
`McpClientConnection`. SDK types, tokens, client registration data, discovery
documents, and code verifiers remain private.

The workbench callback is the exact bound loopback URL `/oauth/callback`. Each
attempt uses a cryptographically random 256-bit `state` value bound to the
target-owning browser session. The callback does not depend on the session
cookie because a cross-site authorization redirect may omit a `SameSite=Strict`
cookie. It instead requires the exact, single-use state value. Callback request
targets are limited to 8,192 bytes, and authorization codes are limited to
4,096 Unicode code points. A callback containing exactly one valid state
consumes the attempt even when the result fields are malformed; an ambiguous
state or oversized request target does not select an attempt.

After consuming a callback, devtools redirects the provider tab to a clean
loopback result path before rendering the outcome. The authorization code,
state, and provider error therefore do not remain in the visible address or the
result page URL.

Discovery and initial authorization preparation have a 15-second deadline.
After the authorization URL is returned, the user has 5 minutes to complete the
browser flow. Token exchange plus MCP initialization has a new 15-second
deadline, followed by the existing separate 15-second catalog deadline. A
timeout, denial, invalid callback, cancellation, target failure, disconnect, or
process shutdown closes the authorization handle and clears all retained OAuth
material.

The OAuth provider stores tokens, dynamic client information, discovery state,
PKCE verifier, and state only in process memory for that active target. The
browser receives only the authorization URL and sanitized connection state. It
never receives a token, authorization code after submitting it, client
registration response, verifier, or discovery document. None of those values
is written to browser storage, diagnostics, Activity, API error bodies, or
verification output.

Backend OAuth fetches use platform TLS validation, reject credentials in URLs,
do not follow redirects, and enforce the existing 10 MiB response boundary.
HTTPS is required. When the explicit MCP resource uses literal `127.0.0.1` or
`[::1]` HTTP for local development, its authorization server may use the same
loopback HTTP exception. A remote HTTPS resource cannot downgrade OAuth
endpoints to loopback HTTP. The browser follows the validated authorization URL
as a normal top-level navigation. Devtools does not proxy, render, or frame the
authorization server.

The protected-resource, authorization-server, registration, authorization, and
token endpoints must use the exact origin of the explicit MCP resource.
Cross-origin endpoints are rejected before a request or browser navigation.
This keeps network authority within the origin the developer selected; broader
identity-provider delegation requires a separate consent and threat-model
decision. Redirects remain forbidden, metadata issuer identity must exactly
match the selected authorization-server identifier, and normal platform DNS,
certificate, and hostname checks remain enabled.

Terminal protected-resource discovery failures are latched and fail closed.
They cannot be swallowed by the SDK's legacy authorization-server fallback.

The official transport may need to repeat the initial MCP initialization
request after the explicit authorization completes. After a connection is
established, devtools does not refresh, up-scope, or replay a tool request
automatically. A later authentication failure closes the target and requires a
new explicit Connect action.

The process still owns one target slot. OAuth adds the observable
`authorizing` state between `connecting` and `connected`. The owning browser may
cancel it; other sessions observe only that the slot is busy. The successful
callback completes initialization and catalog validation before the state
becomes `connected`.

This decision supersedes only ADR 0021's OAuth exclusion. Its prohibitions on
persistence, target discovery, multiple targets, automatic tool calls, retries,
evals, and release gating remain in force.

Normative behavior is specified in the amended
[MCP installation inspection and homologation specification](../specs/mcp-installation-inspection-and-homologation.md).

## Consequences

- A developer can homologate the actual interactive MCP OAuth path without
  copying an access token into devtools.
- OAuth protocol ownership remains inside `@invokta/mcp` and the approved SDK.
- Authorization state and credentials are ephemeral and target-scoped.
- OAuth callbacks add a narrowly bounded unauthenticated loopback route whose
  authority is the single-use state value.
- Machine-to-machine grants, persistent login, provider configuration, custom
  client credentials, and CLI OAuth require another decision.
