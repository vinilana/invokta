# ADR 0055: MCP OAuth client registration strategies

- Status: Accepted
- Date: 2026-11-22

## Context

ADR 0023 assigned every interactive installed-MCP OAuth attempt to the official
MCP SDK's dynamic client registration path whenever the client held no
preconfigured `client_id`. ADR 0031 added read-only discovery inspection that
treated a missing `registration_endpoint` as a failed registration leg and
stated, in its threat model, that the client holds no preconfigured client ID
or secret.

Hosted authorization servers commonly omit RFC 7591 dynamic client registration.
Many instead expect either a **pre-registered public client** with Authorization
Code and PKCE, or **Client ID Metadata Documents (CIMD)** when the authorization
server advertises `client_id_metadata_document_supported`. Requiring DCR for every
attempt creates unstable client identities, enlarges the attack surface of a
public registration endpoint, and blocks deployments that approve clients
through an allowlist.

Issue #63 tracks bringing CIMD and pre-registered public clients to
`@invokta/mcp` and the installed-MCP workbench without reimplementing OAuth
outside the official SDK (ADR 0006).

## Decision

This decision amends ADR 0023 and ADR 0031. Every property those decisions
made remains in force except the assumption that the interactive client always
registers dynamically, and ADR 0031's threat-model clause that the client holds
no preconfigured client ID.

### Registration strategy order

For each interactive OAuth attempt, `@invokta/mcp` selects exactly one client
registration strategy in this order:

1. **Configured pre-registered public client** — when the caller supplies a
   public `client_id` and an exact RFC 8414 `issuer` on the `McpOAuthClientTarget`,
   and when supplied, `redirectUris` includes the exact loopback callback URL used
   for the attempt. No client secret is accepted. The discovered authorization-server
   metadata `issuer` must exactly match the configured `issuer` before any
   authorization URL is returned.
2. **CIMD** — when the validated authorization-server metadata advertises
   `client_id_metadata_document_supported` and no stable pre-registered client
   was configured. A later slice implements the interactive CIMD exchange; until
   then inspection reports the advertisement and the interactive path rejects
   the attempt with `UNSUPPORTED_REGISTRATION`.
3. **Dynamic client registration (DCR)** — only when `registration_endpoint` is
   present in the validated authorization-server metadata and neither (1) nor
   an implemented (2) applies. When metadata has not advertised
   `registration_endpoint`, the client rejects dynamic registration attempts
   (`UNSUPPORTED_REGISTRATION`) instead of allowing the SDK to infer an
   unadvertised `<issuer>/register` fallback.
4. **Unsupported registration** — when none of the above applies, the client
   fails closed with `UNSUPPORTED_REGISTRATION` before browser navigation.
   Generic `CONNECTION_FAILED` is not used for this case.

The client remains a **public** OAuth client: Authorization Code with PKCE
using the `S256` challenge method, `token_endpoint_auth_method` of `none`, and
no client secret. State, PKCE verifiers, authorization codes, tokens, and any
registration artifacts stay process-local and are cleared on completion,
cancellation, timeout, target failure, or process shutdown, as ADR 0023
requires.

When a pre-registered `client_id` is configured, `EphemeralOAuthProvider`
returns it from `clientInformation()` so the official SDK skips DCR. When no
pre-registered client is configured and RFC 8414 metadata is missing or omits
`registration_endpoint`, the client rejects the attempt with
`UNSUPPORTED_REGISTRATION` before any inferred `<issuer>/register` POST instead
of relying on the SDK default registration URL.

Before returning an authorization URL, the facade validates that the URL's
`redirect_uri` exactly matches the bound loopback callback and that a configured
`redirectUris` list includes that callback when present.

### Read-only inspection

`inspectMcpOAuth` reports the registration strategy the interactive client
would select:

- A configured `client_id` and `issuer` yield a successful registration leg when
  the resource and authorization-server metadata match those values, even when
  `registration_endpoint` is absent.
- The authorization-server metadata leg notes when
  `client_id_metadata_document_supported` is advertised.
- The registration leg names DCR when that endpoint is present and no
  pre-registered client overrides it, or reports an unsupported strategy with a
  remediation hint when neither pre-registration, implemented CIMD, nor DCR is
  available.

Inspection still never authorizes, never registers, and never sends a
credential.

### Threat model for pre-registered clients

A malicious MCP resource can still name any authorization server in its
protected resource metadata. Allowing an optional pre-registered `client_id`
without an issuer binding would let that resource funnel the developer's browser
to a real authorization server that already trusts the supplied public client,
reusing ambient consent and minting a token the malicious resource could then use
as a bearer when resource binding is weak.

The configured `issuer` is therefore mandatory with `client_id` and must exactly
match both the advertised authorization server the resource names and the
discovered authorization-server metadata `issuer` before interactive OAuth
proceeds. It must also equal `authorization_servers[0]` in the protected
resource metadata, because the interactive client contacts that first entry.
When a pre-registered client is configured, missing authorization-server
metadata fails closed with `PROTOCOL_ERROR` instead of continuing discovery or
registration against an unvalidated issuer. The client still holds no secret, no
persisted token, and no cookie; PKCE, single-use `state`, and loopback
`redirect_uri` constraints from ADR 0023 remain unchanged.

## Consequences

- Deployments with allowlisted public clients can homologate the interactive MCP
  OAuth path without enabling DCR.
- CIMD-capable servers are visible in inspection before the interactive CIMD
  slice ships.
- Pre-registered credentials are bound to an explicit issuer choice rather than
  any server a resource names.
- Interactive CIMD, DevTools configuration UX for `client_id` and `issuer`, and
  engine-side CIMD publication remain follow-up work tracked under issue #63.
