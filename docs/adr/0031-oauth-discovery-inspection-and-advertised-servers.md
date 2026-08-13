# ADR 0031: OAuth discovery inspection and advertised authorization servers

- Status: Accepted
- Date: 2026-08-13

## Context

ADR 0023 requires the protected-resource, authorization-server, registration,
authorization, and token endpoints to use the exact origin of the explicit MCP
resource, and defers broader identity-provider delegation to a separate
threat-model decision. This is that decision.

The same-origin rule excludes the deployment shape that every hosted engine
has. An engine publishes its Streamable HTTP resource on one origin and
delegates tokens to Auth0, WorkOS, Clerk, Cognito, Firebase, or Supabase on
another. The `examples/auth-*` engines in this repository are all shaped that
way. Under ADR 0023 the interactive OAuth path can only be homologated against a
fixture that also hosts its own authorization server, which is the one topology
nobody deploys.

RFC 9728 already describes the trust chain that makes the delegation safe. A
protected resource publishes, at its own origin, a metadata document naming the
authorization servers that issue tokens for it. A client that reads that
document from the resource origin and then talks only to the servers named in it
has not widened its trust boundary; it has followed the delegation the resource
declared. The origin restriction that matters is the one on the document, not
the one on the servers.

Diagnosis is the second problem. OAuth discovery is a short sequence of
unauthenticated requests: an MCP request that must answer `401` with a
`WWW-Authenticate` challenge, a protected resource metadata document, an
RFC 8414 authorization server metadata document, and an advertised registration
endpoint. `@invokta/mcp` collapses every failure in that sequence into one
`AUTHENTICATION_FAILED` or `CONNECTION_FAILED`, so a developer cannot tell a
missing metadata document from an unreachable authorization server, a malformed
document, an `issuer` that fails the exact-match rule, or a rejected token. The
failing request is knowable before any browser navigation happens.

## Decision

This decision amends ADR 0023. Every property ADR 0023 decided remains in force
except its same-origin endpoint restriction, which the first section below
replaces. ADR 0029 adopts that flow by reference and restates the restriction
while doing so; that clause follows this amendment.

### The resource origin stays the trust anchor

Protected resource metadata is read only from the origin of the explicit MCP
resource, over HTTPS or literal loopback HTTP, at the RFC 9728 path-aware
well-known URL and then the root well-known URL. A `WWW-Authenticate` challenge
that advertises a `resource_metadata` URL on any other origin is rejected as a
protocol error before the request is made: RFC 9728 derives that URL from the
resource identifier, so a cross-origin advertisement is an attempt to move the
anchor. Terminal discovery failures remain latched and fail closed.

### Advertised authorization servers become allowed

Once that document is read and validated, the origins of its
`authorization_servers` entries are allowed for authorization-server metadata
(RFC 8414), dynamic client registration (RFC 7591), the authorization endpoint,
and the token endpoint. Every entry must be an HTTPS URL with no credentials and
no fragment; loopback HTTP is accepted only when the MCP resource is itself
loopback HTTP, so a remote HTTPS resource still cannot downgrade any endpoint. A
document that advertises a malformed or disallowed entry is rejected whole, and
a document that advertises no authorization server is rejected.

The allowlist is a single internal set derived only from that document: the
resource origin, plus the advertised origins once the document has been
validated. Nothing else adds to it, it exists only for the lifetime of one
authorization attempt, and it is cleared with the rest of the OAuth material.
Every point where a URL becomes a network request or a browser navigation
consults that one set.

`serveMcpHttp` publishes the mirror of the loopback rule. Its
`auth.resourceMetadata` validation already accepted a loopback HTTP `resource`
"for loopback HTTP development" while requiring HTTPS of every
`authorizationServers` entry, so a machine running both an engine and an
identity provider could not publish the document this decision tells clients to
read. A loopback HTTP resource may now name a loopback HTTP authorization
server; every other constraint on that URL is unchanged, and an issuer path
stays allowed.

The production requirement does not move: HTTPS everywhere, except literal
loopback on both sides at once. A deployed HTTPS engine still cannot advertise a
plain-HTTP authorization server, and a loopback engine still cannot advertise a
plain-HTTP one that is not loopback. This value is supplied by the engine's own
composition root and never read from a request, so it is configuration a
developer chose rather than input an attacker controls; the exception widens
what a developer may configure locally, not what a peer can induce.

### What the change exposes

A malicious or compromised MCP resource can now name any HTTPS origin and have
the client fetch discovery documents from it, register a public client there,
and hand the developer's browser an authorization URL on it. The same-origin
rule never prevented that attack; a malicious resource could always host an
authorization server on its own origin. The rule only decided which origin
appeared in the address bar.

What remains bounded is what an attacker gains. The client holds no
preconfigured client ID or secret, no persisted token, and no cookie, so every
attempt registers a fresh public client and carries no ambient authority to a
server the developer already trusts. The redirect URI is a literal loopback URL
bound to the running devtools process, so an authorization code can only be
delivered back to that process. PKCE binds the code to a verifier held only in
that process's memory. The RFC 8707 `resource` parameter binds the issued token
to the MCP resource being inspected. A single validated `state` value ties the
callback to the attempt that created it. The authorization URL is a normal
top-level navigation the developer sees and consents to before any credential
is entered.

The residual exposure is the one RFC 9728 accepts by design: the resource you
point the client at chooses your authorization server. Choosing which resource
to inspect stays the developer's decision, and it is the same decision ADR 0022
already required for a bearer token.

### Read-only discovery inspection

`@invokta/mcp` exports `inspectMcpOAuth`, a read-only diagnostic over the same
target descriptor the interactive flow accepts. It performs one unauthenticated
MCP request to observe the `401` challenge, one unauthenticated read of the
protected resource metadata using the same URL derivation the OAuth provider
uses, one unauthenticated read of the first advertised authorization server's
metadata, and one check of whether that server advertises a registration
endpoint. It never authorizes, never registers, never sends a credential, and
leaves nothing behind.

It returns the outcome of every step even when an earlier one failed. A step
whose input a failed step was supposed to produce is reported as skipped, naming
what it depended on. Failures are data: an unreachable host, a `404`, a
malformed document, or a document that fails validation becomes a failed step
with a one-line summary and a remediation hint. A thrown `McpClientError` is
reserved for an invalid target descriptor. The inspection reports that an
interactive authorization can be attempted only when every step succeeded.

Summaries and hints carry protocol facts only. Response bodies appear in a step
detail solely for the two discovery documents, which are unauthenticated public
metadata.

## Relationship to the deploy inspection

ADR 0024 permits `@invokta/deploy` its own read-only OAuth discovery
inspection, and `invokta-deploy inspect-oauth` implements one. This decision
does not replace it, and the duplication is deliberate rather than overlooked.

`@invokta/deploy` declares no dependencies at all: it scaffolds, packages, and
probes an engine without pulling a framework runtime package into the
deployment host. Consolidating the two inspections into `@invokta/mcp` would
add the edge `deploy → mcp` and end that property. The devtools cannot take the
opposite route either, because ADR 0021 keeps it free of any other supporting
package. Two consumers therefore need the same protocol knowledge across a
boundary neither may cross.

The two are also shaped for their callers rather than arbitrarily: the deploy
inspection fails fast with one stage and reason, which is what a homologation
exit code needs, while this one reports every leg, which is what a rendered
report needs. They must stay behaviorally consistent on the legs they share; a
divergence in what either accepts is a defect in whichever drifted.

Extracting a shared implementation requires either a decision to give
`@invokta/deploy` a runtime dependency or a new package both may depend on, and
neither has evidence yet.

## Consequences

- The interactive OAuth path works against the topology real engines deploy, and
  the `examples/auth-*` engines become homologable through the launch path they
  actually use.
- Trust in an authorization server is derived, per attempt, from a document read
  at the resource's own origin, and it disappears when the attempt does.
- An engine and an identity provider can both run on loopback, so the whole
  OAuth chain is exercisable on one machine without a certificate.
- A developer can determine which discovery step fails without starting a
  browser flow, and can distinguish a missing document from an unreachable
  server or an issuer mismatch.
- The inspection widens the public surface of `@invokta/mcp` by one read-only
  function; it grants no new authority, because it sends no credential.
- Trusting an authorization server the resource names accepts that a hostile
  resource selects the authorization page the developer is shown. Persisted
  login, preconfigured client credentials, and any pinning of an expected issuer
  still require another decision.
