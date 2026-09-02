# Invokta Gateway: MVP plan

- Status: Proposal, not delivered behavior. Promote the framework-facing
  decisions to ADRs before changing any package.
- Date: 2026-09-02
- Applies to: a new `apps/gateway` application, one additive option in
  `@invokta/mcp`, `docs/`, and the documentation site

**Invokta Gateway** is a web application that lets an operator create and
configure Action Engines without writing code. The operator registers an
authenticated REST or GraphQL API as a *connector*, chooses which endpoints or
operations each engine exposes, and publishes the engine as its own MCP
Streamable HTTP server. Consumers authorize their MCP client against the
gateway with OAuth and call the published capabilities. Better Auth provides
login, organizations, and the OAuth authorization server; Vercel Connect is the
first supported credential broker for upstream APIs.

This note answers four questions:

1. What is the gateway, and where does it sit relative to the framework?
2. Which contracts does it need from Invokta, and which one is missing?
3. What is the MVP, slice by slice, with acceptance criteria?
4. Which decisions are still open, and what is the recommendation for each?

## Summary of the recommendation

- Build the gateway as an **application under `apps/gateway`**, composed only
  from the public APIs of `@invokta/core` and `@invokta/mcp`. It is a host in
  the sense of `AE-SCOPE-03`: it owns identity, persistence, connectors,
  capability construction, and deployment. The framework package count,
  primitives, error codes, and limits in
  [scope and limits](./scope-and-limits.md) do not change.
- Every capability the gateway builds runs through `engine.invoke`. The web
  playground, the MCP endpoint, and any future channel share that path
  (`AE-INV-04`, ADR 0005, ADR 0007).
- One published engine is **one `serveMcpHttp` instance** with its own RFC 9728
  Protected Resource Metadata and its own audience-bound access tokens. The
  gateway front server routes to those instances.
- The only framework change is **an optional mount path for `serveMcpHttp`**,
  so several engines can share one origin. It is additive, bounded, and needs
  an ADR because ADR 0007 currently fixes the route at `/mcp`. The fallback
  that needs no framework change is one subdomain per engine.
- Authentication uses **Better Auth 1.7** with the `oauthProvider` and `jwt`
  plugins, not the `mcp()` wrapper: `mcp()` binds one resource, while the
  gateway registers one persisted OAuth resource per published engine.
- Upstream credentials enter through the **`CredentialSource` port** from
  [connector brokers](./connector-brokers.md), with a static implementation and
  a Vercel Connect implementation. A third broker is a third module, not a
  framework change.

## Positioning

| Question | Answer |
| --- | --- |
| Is the gateway an Action Engine? | No. It is a host that *produces* Action Engines from configuration. Each published engine qualifies under the [community definition](./action-engines.md): domain-named capabilities, validated contracts, one access rule, replaceable upstream implementation, independent consumers. |
| Is it a framework runtime package? | No. `AE-SCOPE-01` stays at ten packages. The gateway is a private application, like `apps/docs`. |
| Does it add a connector registry, container, or plugin system to Invokta? | No. Connector kinds are compiled into the gateway; the gateway composes engines explicitly at its own composition root with `createEngine`, `defineCapability`, and `defineConnector`. `AE-LIMIT-02` and `AE-LIMIT-03` continue to describe the framework. |
| Is it the level E platform the scope matrix excludes? | It is the first application that would need level E concerns, which is exactly why it must live outside the framework. Federation, routing, rollout, and economics remain out of scope for the MVP as well. |
| Which example is the closest precedent? | [`auth-self-hosted-oauth-engine`](../examples/auth-self-hosted-oauth-engine/): a host-owned authorization server, PostgreSQL persistence, `node:http` servers, and Invokta as the resource server boundary (ADR 0024). |

## Product scope

### Personas

- **Operator**: an organization admin who registers connectors, designs
  engines, and publishes them. Works in the browser.
- **Consumer**: a person using an MCP-compatible client (Claude, Cursor,
  Codex, the Invokta devtools workbench) who authorizes that client against the
  gateway and calls a published engine.

### MVP user journeys

1. Sign up, create an organization, invite a member.
2. Register a REST connector: base URL, authentication mode, one bounded
   connection test.
3. Register a GraphQL connector: endpoint, authentication mode, bounded
   introspection.
4. Create an engine: name, slug, version, description.
5. Add exposures to the engine. A REST exposure is a method, a path template,
   an input contract, and an output contract. A GraphQL exposure is one
   operation document; its contracts derive from the introspected schema.
6. Try an exposure in the browser through `engine.invoke` before publishing.
7. Publish the engine. The gateway starts its MCP server, registers its OAuth
   resource, and shows the MCP URL plus client installation snippets.
8. Authorize an MCP client against the gateway, consent to the engine, and call
   a capability.
9. Use Vercel Connect instead of a stored secret for a connector, including the
   consent-required path for user-scoped tokens.
10. Review a payload-free activity log per engine.

### Explicit non-goals for the MVP

Marketplace or third-party connector plugins loaded at runtime; per-engine
process isolation; usage metering or billing; MCP resources, prompts, tasks, or
sessions (`AE-LIMIT-05`); streaming responses; webhooks or triggers; GraphQL
subscriptions; OpenAPI 2.0 or 3.0; Client ID Metadata Documents and DPoP;
hosting engines as serverless functions; multi-region; engine versioning with
parallel live revisions; per-engine consumer allowlists beyond organization
membership.

## Architecture

```text
                 browser (operator)          MCP client (consumer)
                        |                            |
                        v                            v
 +--------------------- gateway front server (node:http, public origin) ------+
 |  /            /auth/*            /api/*      /e/<slug>/mcp                  |
 |  UI pages     Better Auth        control     /.well-known/oauth-protected-  |
 |               (login, consent,  plane        resource/e/<slug>/mcp          |
 |               OAuth 2.1 AS,     JSON                 |                      |
 |               JWKS)                                  | reverse proxy,       |
 +------------------------------------------------------|-raw Host preserved---+
                        |                               v
                        |            +----------- engine host --------------+
                        |            |  serveMcpHttp(engine A, loopback:p1) |
                        |            |  serveMcpHttp(engine B, loopback:p2) |
                        |            |  ...                                 |
                        |            +---------------|----------------------+
                        v                            v
             +---- PostgreSQL ----+          engine.invoke -> capability
             | Better Auth tables |                 -> port -> connector
             | connectors         |                     -> CredentialSource
             | engines, exposures |                     -> upstream REST/GraphQL
             | secrets, activity  |
             +--------------------+
```

### Components

| Component | Responsibility | Depends on |
| --- | --- | --- |
| Front server | One `node:http` server on the public origin. Serves UI pages and static assets, mounts Better Auth through `better-auth/node`, serves the control-plane JSON API, and reverse-proxies engine routes to the engine host. | Node built-ins, `better-auth` |
| Control plane | Organization-scoped CRUD for connectors, engines, exposures, and secrets; validation of every stored contract; publish and unpublish orchestration. | PostgreSQL through `pg`, plain SQL migrations |
| Capability factory | Turns one stored exposure into a `defineCapability` value: stored JSON Schema becomes a Standard Schema through `zod.fromJSONSchema`; `run` calls one port; `access` is the organization-membership rule. | `@invokta/core`, `zod` |
| Connector kinds | `rest` and `graphql`. Each kind declares its configuration schema, validates exposures, and builds a `defineConnector` factory whose ports the capability factory injects. | `@invokta/core`, Node `fetch` |
| Credential sources | `static` (secret decrypted from the database) and `vercel-connect` (`@vercel/connect`). Both implement the engine-owned `CredentialSource` port. | `@vercel/connect` |
| Engine host | Keeps one `serveMcpHttp` handle per published engine on a loopback port, rebuilds an engine when its revision changes, and closes it on unpublish. | `@invokta/mcp` |
| Authorization server | Better Auth `oauthProvider` with `jwt`; one persisted OAuth resource per published engine; login and consent pages owned by the gateway. | `better-auth`, `@better-auth/oauth-provider` |
| Token verification | The `auth.authenticate` hook of each engine: verify the bearer JWT against the gateway JWKS with `jose`, require the engine resource as audience, and map an enumerated claim allowlist to a `Principal`. | `jose` |
| Activity | Consumes `onEvent` from every hosted engine and stores the three payload-free events per invocation. | PostgreSQL |

All dependencies stay inside the application. No framework package gains a
dependency on Better Auth, PostgreSQL, Vercel Connect, or `jose`.

### Request flows

**Publish.** The control plane validates the engine, snapshots its exposures
into an immutable revision, creates or enables the OAuth resource
`https://<gateway>/e/<slug>/mcp` through the Better Auth admin API, and asks
the engine host to start the revision. The host builds the engine, calls
`validateMcpToolCatalog`, and starts `serveMcpHttp` with `auth.mode:
"required"`, `resourceMetadata`, and `challengeScopes`. Publishing fails closed
if the tool catalog collides or the resource cannot be registered.

**Consumer authorization.** The MCP client receives a 401 with a Bearer
challenge naming the engine's resource metadata. Metadata advertises the
gateway as the authorization server. The client discovers the authorization
server metadata, registers dynamically, and runs Authorization Code with PKCE
with `resource=<engine resource>`. The gateway login page authenticates the
person; the consent page names the engine, the organization, and the scopes.
The issued access token is a JWT with `aud` equal to the engine resource,
`sub` equal to the gateway user id, and `scope` containing `mcp:tools`.

**Tool call.** The front server proxies the POST to the engine's loopback
port, preserving the raw `Host` and `Authorization` headers and adding no
forwarded-host header. The engine's `authenticate` hook verifies the token
and returns the principal. `engine.invoke` validates input, runs the access
rule, then `run` resolves a credential through `CredentialSource.get({
principal, signal })`, calls the upstream API, translates the response, and
returns it for output validation.

## Contracts the gateway consumes

| Contract | Use in the gateway | Source |
| --- | --- | --- |
| `defineCapability`, `createEngine`, `engine.invoke`, `list`, `describe` | Build and execute every capability | ADR 0001, ADR 0003 |
| Standard Schema and Standard JSON Schema through `zod` | Stored JSON Schema contracts become runtime validation and MCP tool descriptions | ADR 0002 |
| `defineConnector` | One typed factory per connector kind; capabilities receive only the port they use | ADR 0036, ADR 0037 |
| `serveMcpHttp` with required authentication, `resourceMetadata`, `challengeScopes`, `allowedHosts` | One MCP server per published engine | ADR 0007, ADR 0024 |
| `validateMcpToolCatalog` and `toMcpToolName` | Publish gate; tool names shown in the UI | ADR 0025, ADR 0026 |
| `onEvent` | Activity log | ADR 0003 |
| `connectMcpClient`, `beginMcpOAuthAuthorization`, `inspectMcpOAuth` | End-to-end tests against a running gateway | ADR 0023, ADR 0031 |
| `EngineError` with the seven codes | The only failure vocabulary connectors may raise | ADR 0003 |
| `CredentialSource<Credential>` | Engine-owned port for request-time credentials | [connector brokers](./connector-brokers.md) |

## The missing contract: mounting several engines on one origin

`serveMcpHttp` binds its own `node:http` server and accepts exactly the
`/mcp` route; `resourceMetadata.resource` must end in `/mcp` as well
(ADR 0007). Two engines therefore cannot share one origin today.

| Option | Framework change | Operational cost | Assessment |
| --- | --- | --- | --- |
| A. One subdomain per engine (`<slug>.gateway.example.com/mcp`) | None | Wildcard DNS and TLS; `*.localhost` does not resolve through Node's resolver, so local development needs an explicit `Host` header or a hosts file | Correct and available now; awkward for local development and for operators without wildcard DNS |
| B. Optional `path` for `serveMcpHttp` (`/e/<slug>/mcp`) | Additive option, one ADR amending ADR 0007 | None beyond the front proxy the gateway needs anyway | Recommended |
| C. Handler-style adapter that mounts inside the gateway's own server | New adapter surface | None | Larger contract; also what serverless hosting would need; defer |

**Recommendation: option B.** The change is bounded:

- `path` defaults to `/mcp`; when supplied it MUST be an absolute, normalized
  path without query, fragment, dot segments, or trailing slash, at most 256
  bytes, and MUST end in `/mcp` so the canonical MCP route stays visible.
- The route check, the `resourceMetadata.resource` check, and the
  authentication request `path` use the configured value.
- The Protected Resource Metadata document is served at the RFC 9728
  path-suffix location (`/.well-known/oauth-protected-resource<path>`), which
  the isolated SDK helper already derives from the resource URL.
- `invokta-deploy probe` and `inspect-oauth` accept the same path rule instead
  of requiring exactly `/mcp`.
- Everything else in ADR 0007 is unchanged: statelessness, one raw `Host`,
  the host allowlist, ignored forwarded headers, body limits, and the
  authentication order.

The gateway front server proxies `/e/<slug>/mcp` and its metadata path to the
engine's loopback port. The proxy preserves the raw `Host` header so the
engine's `allowedHosts` check sees the public host, forwards `Authorization`,
`Accept`, `Content-Type`, `Content-Length`, and `MCP-Protocol-Version`,
drops hop-by-hop and every `X-Forwarded-*` header, bounds the request body to
the engine's own limit, and propagates client disconnect as an abort.

Until the ADR lands, slices 1 to 3 need no MCP server at all, so the decision
does not block the start of the work.

## Authentication and authorization

### Operator identity

Better Auth with email and password plus the `organization` plugin. Every
control-plane row carries `organization_id`; every query is scoped by the
active organization of the session. Roles are `owner`, `admin`, and
`member`; only `owner` and `admin` may manage connectors, secrets, and
publication.

### Consumer authorization

The gateway is the OAuth 2.1 authorization server for every engine it hosts.

- Plugins: `jwt()` for the signing key and `/api/auth/jwks`, and
  `oauthProvider()` from `@better-auth/oauth-provider`. The `mcp()` wrapper
  from `@better-auth/mcp` is not used: it requires a single `resource` and
  ships resource-server helpers that target MCP `2026-07-28` with legacy
  clients rejected, while Invokta pins protocol `2025-11-25` (ADR 0006). The
  authorization server side of OAuth is protocol-version neutral, so the
  combination is compatible.
- Resources: `oauthProvider` persists resources as first-class rows. Publishing
  an engine creates or enables the resource whose identifier is the engine
  resource URL; unpublishing disables it. `enforcePerClientResources` is
  `false` in the MVP so a client registered once can be authorized for any
  engine the person consents to; consent plus audience binding plus the
  organization rule protect each engine.
- Client registration: `allowDynamicClientRegistration` and
  `allowUnauthenticatedClientRegistration` are on, because current MCP clients
  and Invokta's own client facade register dynamically. Client ID Metadata
  Documents follow when Invokta adopts MCP `2026-07-28`.
- Scopes: `openid`, `profile`, `email`, `offline_access`, and the custom
  `mcp:tools`. Every engine advertises `challengeScopes: ["mcp:tools"]`.
- Consent page: gateway-owned, shows the engine name, the owning organization,
  and the scopes. A person who is not a member of the engine's organization can
  still complete OAuth; the capability access rule rejects the call with
  `FORBIDDEN`. The consent page SHOULD warn about that before consent.
- Token lifetime: access tokens 1 hour, refresh tokens 30 days with rotation,
  both Better Auth defaults.

### Token verification in the engine host

Each hosted engine's `authenticate` hook follows
[`auth-better-auth-engine`](../examples/auth-better-auth-engine/): read one
Bearer token, verify with `jose` against a bounded remote JWKS
(`createRemoteJWKSet` with a timeout and a cooldown), require `iss` equal to
the gateway base URL and `aud` equal to this engine's resource, return `null`
for every unusable credential, and throw only when the JWKS cannot be fetched
so the adapter answers 500 rather than a misleading 401. The principal carries
an enumerated allowlist:

```ts
{
  id: claims.sub,
  attributes: {
    organizationId: claims.activeOrganizationId, // when present
    scopes: claims.scope.split(" "),
    clientId: claims.client_id,                  // when present
  },
}
```

No token, header value, or raw payload reaches the principal, an error, an
event, or a log line.

### Capability access rule

Every generated capability declares a function rule:

1. `principal` is not `null`;
2. `scopes` contains `mcp:tools`;
3. the principal's user is a member of the engine's organization, checked
   through a repository port with a bounded in-memory cache (60 seconds).

Denial is `FORBIDDEN`. The rule runs before `run`, so no upstream credential
is minted for a forbidden call (`AE-PIPE-01`).

### Web session security

Better Auth cookie sessions for the UI; state-changing control-plane requests
require a same-origin `Origin` header and a per-session CSRF token; the front
server sends no CORS headers; secrets are write-only fields and are never
rendered back.

## Connector model

### Common shape

```text
Connector
  id, organization_id, name, kind: rest | graphql
  base_url                      https:// required; http:// only for literal loopback
  auth: none
      | static-bearer           secret_id
      | static-header           header_name, secret_id
      | basic                   username, secret_id
      | vercel-connect          connector_uid, subject_policy: app | user
  timeout_ms (default 10_000, max 60_000)
  max_response_bytes (default 10 MiB)
```

The base URL is validated at configuration time: absolute, no userinfo, no
query, no fragment, HTTPS unless literal loopback, and the resolved host MUST
NOT be a link-local or metadata address. Re-resolution between check and
request is a known residual risk; the plan records it rather than claiming
full SSRF protection.

### `rest`

An exposure is:

```text
Exposure (rest)
  capability_id   "<domain>.<action>", validated by the core capability-id rule
  method          GET | POST | PUT | PATCH | DELETE
  path_template   "/customers/{id}/orders", placeholders as whole segments only
  query           [{ name, from: input.<field> }]
  headers         [{ name, from: input.<field> }]   (never Authorization)
  body            from: input.<field> | whole input | none
  input_schema    JSON Schema 2020-12 object root
  output_schema   JSON Schema 2020-12 object root, or the passthrough object
  timeout_ms, annotations (readOnly, destructive, idempotent, openWorld)
```

The runtime mirrors the generated OpenAPI engine (ADR 0038): the request URL
is serialized from the connector origin plus the encoded template before the
credential is applied, so input can never change the destination; every
placeholder is substituted; the response body is decoded within the byte
limit; a non-2xx status becomes `EXECUTION_FAILED` with `status` and
`provider` in public details and never the body; a schema-invalid response is
`EXECUTION_FAILED` too; cancellation and timeout propagate through
`context.signal`.

OpenAPI import (slice 7) fills exposures from a document instead of the form.
The discovery logic exists in `create-invokta-engine` but is not exported;
see decision D4.

### `graphql`

A connector stores its endpoint and authentication. When it is created or
refreshed, the gateway runs one bounded introspection query (timeout, 5 MiB
response, 10,000 types and fields) and stores the schema snapshot.

An exposure is one operation document:

```text
Exposure (graphql)
  capability_id
  document        one named query or mutation with typed variables
  operation_name
  input_schema    derived from the variable definitions and the snapshot
  output_schema   derived from the selection set and the snapshot
```

Deriving both contracts from the document keeps the MVP deterministic and
avoids inventing selection sets. At runtime the connector posts `{ query,
variables, operationName }`; any entry in `errors` fails the invocation with
`EXECUTION_FAILED` and a sanitized message, and `data` is validated against
the output contract.

### Credential sources

The port from the connector-brokers note is adopted verbatim and owned by the
gateway:

```ts
interface CredentialRequest {
  readonly principal: Principal | null;
  readonly signal: AbortSignal;
}

interface CredentialSource<Credential> {
  get(request: CredentialRequest): Promise<Credential>;
}
```

- `static` decrypts the secret referenced by the connector and returns it.
- `vercel-connect` calls `getTokenResponse(connectorUid, { subject })` from
  `@vercel/connect`. The subject policy is connector configuration: `app`
  mints the organization's installation token; `user` maps the principal to
  `{ type: "user", id: principal.id }`. The gateway is the issuer of that
  `principal.id`, so the mapping is explicit and the namespaces coincide by
  construction rather than by accident. An `app` subject is refused on a
  capability whose rule is not membership-gated, which every gateway
  capability is.
- `UserAuthorizationRequiredError` becomes `FORBIDDEN` with `publicDetails`
  `{ reason: "connector-authorization-required", connector, authorizationUrl }`,
  where the URL comes from `startAuthorization` with a callback into the
  gateway. `ConnectorInstallationRequiredError` and every other `ConnectError`
  become `EXECUTION_FAILED` with the error code and never the vendor payload.
  Cancellation becomes `CANCELLED`.
- The SDK caches in process and refreshes near expiry; the gateway adds no
  second cache. On a 401 from the upstream API the connector calls
  `deleteTokenCacheEntry` once and does not retry the invocation.
- The broker credential is a Vercel OIDC token when the gateway runs on Vercel
  and a Vercel access token (`GATEWAY_VERCEL_TOKEN`) otherwise. The plan is
  explicit that the container topology trades many provider secrets for one
  platform secret.

### Extending to a third-party connector later

A connector kind is a compiled-in module with a fixed interface:

```ts
interface ConnectorKind<Config, ExposureSpec> {
  readonly kind: string;
  readonly config: StandardSchema<Config>;           // operator form
  validateExposure(config, spec): Issue[];           // at save time
  deriveContracts(config, spec): { input, output }; // JSON Schema
  connector: ConnectorFactory<...>;                  // defineConnector value
  capability(config, spec, ports): CapabilityDefinition;
}
```

Adding Nango, Composio, or a SaaS-specific kind is a new module plus tests. It
is not runtime discovery, and the gateway MUST NOT load kinds from the
database or from packages named at runtime.

## Data model

| Table | Owner | Notes |
| --- | --- | --- |
| `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `jwks` | Better Auth | Generated by the Better Auth CLI; committed as SQL |
| `oauth_client`, `oauth_resource`, `oauth_client_resource`, `oauth_consent`, `oauth_refresh_token`, `oauth_authorization_code` | Better Auth `oauthProvider` | Resource rows are created by the gateway on publish |
| `secret` | Gateway | `id`, `organization_id`, `ciphertext`, `nonce`, `created_at`; AES-256-GCM under `GATEWAY_SECRET_KEY`; never selected by list endpoints |
| `connector` | Gateway | Common shape above plus `kind_config` JSON and `schema_snapshot` for GraphQL |
| `engine` | Gateway | `id`, `organization_id`, `slug`, `name`, `description`, `version`, `status: draft | published | disabled`, `resource_url`, `published_revision_id` |
| `exposure` | Gateway | One row per capability; `kind_spec` JSON; contracts stored as JSON Schema |
| `engine_revision` | Gateway | Immutable snapshot of the engine and its exposures at publish time; the host runs revisions, not drafts |
| `invocation_event` | Gateway | `request_id`, `engine_id`, `capability_id`, `source`, `principal_id`, `type`, `code`, `duration_ms`, `at`; no payloads |

Migrations are ordered SQL files applied by a small script, as in the
self-hosted OAuth example. No ORM.

## Repository placement and toolchain

- `apps/gateway` becomes a root workspace and a project reference in
  `tsconfig.json`, so it links `@invokta/core` and `@invokta/mcp` from the
  workspace and runs under `yarn run check`. The published packages remain
  exactly the ten in `AE-SCOPE-01`; the release scripts already skip private
  workspaces.
- Runtime dependencies: `better-auth`, `@better-auth/oauth-provider`, `pg`,
  `jose`, `zod`, `@vercel/connect`. Development: `vitest`, `@types/pg`.
- The UI is server-rendered HTML with small progressive-enhancement TypeScript
  modules, the pattern already used by `@invokta/devtools`. No client
  framework or bundler is introduced in the MVP; see decision D7.
- Tests use the Better Auth memory adapter and in-memory repository
  implementations by default. PostgreSQL-backed integration tests run when
  `GATEWAY_TEST_DATABASE_URL` is set and are skipped otherwise, so the
  canonical gate stays hermetic.
- Deployment follows the container pattern of `@invokta/deploy`: a
  multi-stage Dockerfile, non-root user, health check, `.env` excluded. The
  MVP targets one long-running container (Railway, a VPS, or Compose with
  PostgreSQL). Serverless hosting of engines needs option C above and is
  deferred.

## Delivery plan

Each slice is one vertical increment delivered under
[the delivery workflow](./implementation-plan-and-acceptance-criteria.md):
RED first for executable behavior, one cohesive commit, documentation in the
same change. Slice order minimizes time to a working end-to-end path while
keeping the framework change isolated.

| Slice | Deliverable | Acceptance criteria | Evidence |
| --- | --- | --- | --- |
| S0 | ADR: gateway application boundary and `serveMcpHttp` mount path | The ADR records the boundary in the positioning table, the path rule above, and the unchanged ADR 0007 guarantees. `docs/scope-and-limits.md` gains no new package. | Documentation-only exception; link and formatting validation |
| S1 | `apps/gateway` skeleton | Workspace builds and type-checks under `yarn run check`; `node dist/main.js` serves `/healthz`; Better Auth sign-up, sign-in, organization creation, and invitation work through the browser; migrations apply idempotently against PostgreSQL. | Vitest with the memory adapter; PostgreSQL integration test gated by env |
| S2 | REST connectors with static credentials | Create, edit, disable a connector; secret stored encrypted and never returned; the connection test performs exactly one bounded request and reports status without the body; base-URL validation rejects userinfo, query, fragment, plain HTTP off loopback, and link-local hosts. | Fake `fetch`; canary secret never appears in responses, logs, or events |
| S3 | Engines, REST exposures, and the try-it panel | An exposure with valid contracts becomes a capability; `engine.list` and `describe` reflect it; the try-it panel invokes with `source: "direct"` and the operator's principal; invalid input, upstream 4xx/5xx, timeout, and schema-invalid responses map to the documented codes; `validateMcpToolCatalog` runs on every save and reports collisions. | Unit tests on the capability factory; import-graph test proving the web layer calls only `engine.invoke` |
| S4 | Publish: engine host, front proxy, per-engine OAuth resource, token verification | Publishing starts one `serveMcpHttp` per engine with `resourceMetadata` and `challengeScopes`; an unauthenticated request gets the Bearer challenge; `inspectMcpOAuth` reports `ready`; `beginMcpOAuthAuthorization` completes login, consent, and token exchange against the running gateway; a token for engine A is rejected by engine B; a non-member gets `FORBIDDEN` inside HTTP 200; unpublish closes the server and disables the resource; `invokta-deploy probe --expect ready` passes. | End-to-end Vitest fixture with the `@invokta/mcp` client facade; the same flow through the devtools MCP workbench as manual homologation |
| S5 | GraphQL connectors and operation exposures | Introspection is bounded and stored; a document with typed variables produces the derived contracts; an `errors` entry fails the invocation; the same publish path serves the capability. | Fake GraphQL upstream with fixtures for scalars, enums, input objects, lists, nullability |
| S6 | Vercel Connect credential source | `app` and `user` subjects mint through a stub broker; consent-required becomes `FORBIDDEN` with `authorizationUrl`; the callback route returns the person to the engine page; cancellation propagates; no broker token or vendor payload appears in details, events, or logs. | Stub broker that never reaches the network, per the `firecrawl-stub` convention |
| S7 | OpenAPI import into exposures | A bounded local OpenAPI 3.1 document pre-fills REST exposures with the same eligibility rules and limits as ADR 0038; unsupported operations are listed with reasons. | Reuse the ADR 0038 fixtures |
| S8 | Activity, installation snippets, deployment | The activity page shows the three events per invocation with no payloads; the engine page renders Claude, Cursor, and Codex remote-server snippets and an `invokta.mcp.json` descriptor; the Dockerfile builds and the health check passes; a documentation-site page introduces the gateway. | `yarn check:examples` unaffected; `apps/docs` validation |

S0 through S3 do not depend on the mount-path ADR. S4 does.

## Fixed limits

| Dimension | Limit |
| --- | --- |
| Connectors per organization | 50 |
| Engines per organization | 50 |
| Published engines per gateway instance | 50 |
| Exposures per engine | 100 |
| Stored contract size | 64 KiB, 1,000 schema nodes, depth 32 |
| JSON Schema features | 2020-12 object roots; local `$ref` only; `pattern` and `format` are kept as descriptions and not enforced, so a stored document cannot supply a regular expression |
| Path template | 2,048 bytes, placeholders only as whole path segments |
| Upstream timeout | default 10 s, maximum 60 s |
| Upstream request and response body | 10 MiB each |
| GraphQL introspection | 30 s, 5 MiB, 10,000 types and fields |
| Secret size | 8 KiB |
| Engine host bind | loopback only; the public origin is the front server |
| Access-token lifetime | 1 hour; refresh 30 days |

The numbers mirror existing framework limits where one exists and are
otherwise conservative starting points that the ADR may adjust.

## Security notes

- **Single execution path.** The try-it panel and the MCP server both call
  `engine.invoke`; a repository test asserts that no module under
  `apps/gateway/src/web` imports a capability's `run`.
- **Secrets.** Encrypted at rest with a key from the environment, decrypted
  only inside a `CredentialSource`, redacted from every diagnostic through a
  canary test, and never present in `invocation_event`.
- **Tokens.** Access tokens are audience-bound per engine; the engine host
  never logs headers; consent URLs from the broker carry state and are
  returned once in public details, never stored or logged.
- **Tenancy.** Every control-plane query is scoped by `organization_id`; the
  access rule re-checks membership at invocation time rather than trusting a
  claim alone.
- **Upstream reach.** Base-URL validation, origin-confined request
  serialization, bounded bodies, and finite deadlines. Residual risk: DNS
  re-resolution after validation.
- **Front proxy.** Preserves the raw `Host`, drops forwarded headers, bounds
  bodies, and refuses any path that is not an engine route, so ADR 0007's
  host and origin defenses still apply at the engine.
- **Isolation.** Engines share one process in the MVP. A slow upstream is
  bounded by its deadline; a crash in connector code is caught by the
  pipeline; a memory leak or event-loop stall would affect all engines. Per
  engine processes are the documented follow-up.

## Open decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Where the gateway lives | `apps/gateway` as a private root workspace, so it links workspace packages and runs under the canonical gate; `apps/docs` keeps its separate lockfile because it has no framework dependency |
| D2 | Several engines on one origin | Option B, an optional `path` for `serveMcpHttp`, recorded in the S0 ADR; option A remains the fallback with no framework change |
| D3 | Engine isolation | In-process host for the MVP with a supervisor interface that can later run one child process per engine |
| D4 | OpenAPI discovery reuse | Defer to S7. Options then: export a pure `create-invokta-engine/openapi` subpath, move discovery into `@invokta/tooling`, or copy a bounded subset into the gateway. Do not decide before the REST runtime exists |
| D5 | `enforcePerClientResources` | `false` in the MVP; revisit when consumer allowlists exist |
| D6 | Client registration | Dynamic Client Registration now; Client ID Metadata Documents when Invokta adopts MCP `2026-07-28` |
| D7 | UI stack | Server-rendered HTML with progressive-enhancement modules, following `@invokta/devtools`; revisit if the operator screens outgrow it |
| D8 | Hosting | One container with PostgreSQL first; Vercel-hosted engines wait for a handler-style adapter (option C) |
| D9 | Consumer access | Organization membership plus `mcp:tools` in the MVP; per-engine allowlists later |
| D10 | Engine versioning | The operator sets `version`; publish snapshots a revision; only one revision is live per engine |

## Sources

Verified in the authoring environment on 2026-09-02:

- `@vercel/connect` 2.0.1 type definitions: `getToken`, `getTokenResponse`,
  `startAuthorization`, `deleteTokenCacheEntry`, subject types `app`,
  `user`, `jwt-bearer`, and `token`, and the `UserAuthorizationRequiredError`
  and `ConnectorInstallationRequiredError` classes; the `/betterauth` subpath
  targets inbound sign-in through `genericOAuth` and is not used here.
- `@better-auth/mcp` 1.7.2 and `@better-auth/oauth-provider` 1.7.2 type
  definitions: `mcp()` requires one `resource`; `oauthProvider()` accepts
  persisted `resources`, `enforcePerClientResources`,
  `allowDynamicClientRegistration`, and
  `allowUnauthenticatedClientRegistration`.
- `zod` 4.4.3 exports `fromJSONSchema`.
- `@modelcontextprotocol/sdk` latest is 1.30.0, the version ADR 0006 isolates.
- [Better Auth 1.7 release notes](https://better-auth.com/blog/1-7),
  [MCP plugin](https://better-auth.com/docs/plugins/mcp),
  [OAuth 2.1 provider](https://better-auth.com/docs/plugins/oauth-provider),
  [Vercel Connect](https://vercel.com/docs/connect), and
  [the MCP 2026-07-28 announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/).
