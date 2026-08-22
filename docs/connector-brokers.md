# Connector brokers and request-time credentials

- Status: Proposal, not delivered behavior. Promote to an ADR before changing
  any package.
- Date: 2026-08-22
- Applies to: `@invokta/core`, `@invokta/deploy`, `examples/`, recipes

A **connector broker** is a service that holds a team's third-party
authorizations and mints a short-lived credential on demand, instead of the
application storing a long-lived provider secret. [Vercel
Connect](https://vercel.com/docs/connect) is the concrete case that motivated
this note; Nango, Composio, WorkOS Connect, and a secret manager such as Vault
occupy the same position.

This note answers two questions:

1. How does an Action Engine capability obtain a brokered credential during one
   invocation?
2. How does that generalize so a second and third broker cost a composition
   root change rather than a framework change?

## Summary of the recommendation

Invokta needs **no change to `@invokta/core`, `@invokta/mcp`, or
`@invokta/deploy`** to integrate a connector broker. The required seam already
exists as `AE-ARCH-02` — implementations enter through a factory or closure at
the composition root.

What is missing is one **documented pattern**: the existing outbound-provider
recipe resolves a credential *once at boot* and closes over a `string`. A broker
resolves a credential *per invocation*, with a TTL, and possibly *per end user*.
Replacing the closed-over `string` with a closed-over **function** covers every
broker examined below.

The deliverable is therefore a port, an example, and a recipe — not a package.

## What a broker changes

The current documented pattern is
[`external-provider.mdx`](../apps/docs/src/content/docs/recipes/external-provider.mdx)
step 4, implemented by
[`crawl-engine`](../examples/crawl-engine/src/engine.ts): read
`FIRECRAWL_API_KEY` at the composition root, hand the adapter
`{ apiKey: string }`, keep it for the life of the process.

| Assumption in the current recipe | Broker reality |
| --- | --- |
| The credential is a `string` known before `createEngine` | The credential is minted on demand and has an expiry |
| One credential serves the whole process | The token rotates; a stale token fails mid-process |
| One credential serves every caller | A user-subject token is scoped to *that end user's* grant |
| A missing credential fails at boot | A missing **grant** fails at invocation time and is recoverable by sending a human to a consent URL |

The first two are mechanical. The last two are the actual design work, because
they touch `Principal` and the closed set of error codes.

## Decision boundary

Restating `AE-SCOPE-02`/`AE-SCOPE-03` for this integration:

**Invokta owns** the invocation pipeline, `Principal`, `AccessRule` enforcement,
the seven error codes, cancellation, and the adapters. None of them change.

**The engine owns** the broker client, the connector reference, the
principal-to-subject mapping, the credential cache policy, the consent recovery
contract, and the deployment topology that supplies the broker's own
credential.

Three things Invokta must **not** do, each of which would violate an accepted
invariant:

| Tempting shortcut | Violates |
| --- | --- |
| Add `context.connectors` or `context.credentials` to `ExecutionContext` | `AE-CTX-01` — the context is closed at five fields and carries no service locator or metadata bag |
| Ship `@invokta/connect` now | `AE-LIMIT-02`, `AE-SCOPE-04` — no runtime plugin discovery; abstractions require repeated evidence |
| Add a `CONNECTOR_AUTHORIZATION_REQUIRED` error code | `AE-LIMIT-*`, ADR 0003 — the error set is closed at seven codes |

This mirrors the boundary ADR 0024 already drew for inbound OAuth: Invokta owns
the protocol contract and the conformance path; one official example owns a
replaceable provider implementation.

## The port

Engine-owned, declared next to the other ports in `application/ports.ts`.
Framework-neutral and broker-neutral:

```ts
import type { Principal } from "@invokta/core";

/** Resolved once per invocation, immediately before the outbound request. */
export interface CredentialRequest {
  readonly principal: Principal | null;
  readonly signal: AbortSignal;
}

export interface CredentialSource<Credential> {
  get(request: CredentialRequest): Promise<Credential>;
}

/** The common case: a bearer token with a known expiry. */
export interface BearerCredential {
  readonly token: string;
  readonly expiresAt?: number;
}
```

The credential type is a parameter because not every provider takes a bearer
token; an engine that needs a signed request or a client handle picks its own
shape. Keeping the port in the engine is what makes that possible.

The infrastructure adapter closes over the source instead of the secret:

```ts
export function createFirecrawlWebCrawler(options: {
  readonly credentials: CredentialSource<BearerCredential>;
  readonly baseUrl?: string;
}) { /* ... */ }

// inside each outbound call, with the invocation's own principal and signal
const { token } = await options.credentials.get({ principal, signal });
```

This requires the adapter to receive the invocation's `principal`, which the
capability already has on `context`. The port signature changes; the capability
contract does not.

### Two implementations satisfy `AE-SCOPE-04`

**Static** — behavior-identical to today, and the migration path for every
existing example:

```ts
export function createStaticCredentialSource(
  token: string,
): CredentialSource<BearerCredential> {
  return { get: async () => ({ token }) };
}
```

**Vercel Connect** — the broker case:

```ts
import { getToken } from "@vercel/connect";

export function createVercelConnectCredentialSource(options: {
  readonly connector: string;             // e.g. "slack/acme-slack"
  readonly subject: (request: CredentialRequest) => ConnectSubject;
}): CredentialSource<BearerCredential> {
  return {
    async get(request) {
      const token = await getToken(options.connector, {
        subject: options.subject(request),
      });
      return { token };
    },
  };
}
```

One port, two implementations, no framework code. A third broker is a third
module in `infrastructure/`.

## Principal-to-subject mapping

Vercel Connect mints a token for a subject that is an app, a named user, or a
JWT-bearer federated identity. Invokta's `Principal` is deliberately minimal,
`{ id, attributes? }`, and `AE-PRINCIPAL-01` standardizes nothing beyond `id`.

The mapping is **engine-owned policy declared at the composition root**, and it
must be explicit:

```ts
createVercelConnectCredentialSource({
  connector: "slack/acme-slack",
  subject: ({ principal }) =>
    principal === null
      ? { type: "app" }
      : { type: "user", id: toConnectUserId(principal) },
});
```

Three rules, each of which is a real failure if broken:

1. **Never pass `principal.id` through unmapped.** The engine's principal id
   comes from whatever the host `authenticate` hook produced: a Clerk user id,
   an Auth0 `sub`, an API-key label. That is a different namespace from the
   broker's user id. Translate deliberately, and use the broker's issuer field
   where it exists to disambiguate.
2. **Never select `app` subject on a `public` capability.** An app subject acts
   with the team's full connector grant. Combined with `access: "public"` that
   is an unauthenticated caller borrowing the team's Slack or GitHub
   authorization. A capability that resolves an app-subject credential MUST
   declare `authenticated` or a function rule.
3. **Rely on pipeline order.** `AE-PIPE-01` enforces `access` before `run`, so
   no token is ever minted for a forbidden call. Keep credential resolution
   inside `run` — never inside an access rule — to preserve that.

## Failure mapping

The broker introduces one genuinely new outcome: the caller is authenticated to
the engine, but has not yet authorized the connector. Vercel Connect surfaces
this as an authorization-required error on the first user-subject request and
offers a consent URL to recover.

It maps to the existing closed set as **`FORBIDDEN`**, with the recovery hint in
`publicDetails`:

```ts
throw new EngineError({
  code: "FORBIDDEN",
  message: "Connector authorization is required.",
  publicDetails: {
    reason: "connector-authorization-required",
    connector: "slack/acme-slack",
    authorizationUrl,
  },
});
```

`FORBIDDEN` rather than `UNAUTHENTICATED` is load-bearing. `UNAUTHENTICATED`
travels to an MCP HTTP client as a 401 with a Bearer challenge, which tells that
client to re-authorize **against the engine** — the wrong authorization server
entirely, producing a retry loop that can never succeed. The identity the engine
required is present; only the downstream grant is missing.

Remaining broker failures map without ambiguity:

| Broker outcome | Code | Notes |
| --- | --- | --- |
| Grant missing for this subject | `FORBIDDEN` | Carries `authorizationUrl` |
| Connector not configured, broker credential missing or expired | `EXECUTION_FAILED` | Operator misconfiguration, not a caller problem |
| Broker unreachable, rate limited, or 5xx | `EXECUTION_FAILED` | Include `provider` and `status`, never the body |
| Invocation cancelled or timed out during resolution | `CANCELLED` | Pass `context.signal` into the broker call |

`publicDetails` crosses the adapter boundary to the caller. It MUST NOT contain
the token, the broker's own credential, or a raw provider body — the same rule
the existing recipe applies to provider errors. The consent URL is
human-facing and safe to return, but it carries state: mint it per request and
keep it out of logs and events.

MCP elicitation is out of scope by `AE-LIMIT-05`, so the consent URL travels as
structured error detail and the client decides how to present it. That is the
correct layering, not a workaround.

## Caching

`@vercel/connect` keeps an in-process cache and refreshes near expiry, so
calling it per request is cheap. **Do not add a second cache around a broker
that already caches.**

For a broker that does not cache, an engine-owned cache is legitimate, with one
non-negotiable rule: **the cache key MUST include the subject.** A key of
`connector` alone hands user A's token to user B on the next request. Also key
on the connector reference, refresh before expiry rather than on failure, and
never persist the cache to disk.

## Deployment

`@vercel/connect` authenticates to Vercel with an OIDC token that the platform
injects into a Vercel deployment and that `vercel env pull` writes to a local
env file for development. That yields three topologies:

| Topology | Broker credential | Assessment |
| --- | --- | --- |
| Engine runs on Vercel | Platform-injected, rotating | Recommended. `serveMcpHttp` is already stateless, so the entry point is a user-owned composition root in the platform's function directory — the same role `src/mcp-http.ts` plays today |
| Engine runs in a container elsewhere | A long-lived Vercel token in the container environment | Works, and partially defeats the purpose: one long-lived secret replaces every provider secret. Acceptable as a consolidation step; say so plainly rather than presenting it as secretless |
| Local development | `vercel env pull` into an env file | Already supported. The generated `src/env.ts` loads env files with `util.parseEnv` and the generated `.dockerignore` excludes every `.env*` |

`@invokta/deploy` needs no change for any of the three. Its generated container
build reinstalls from the engine's lockfile, so a broker SDK is an ordinary
engine dependency. ADR 0011 keeps provider-specific manifests out of scope, and
that holds: Invokta should document the Vercel entry point, not generate a
`vercel.json`.

A broker also has a public HTTP endpoint — Vercel Connect exposes a token
endpoint authenticated with the same OIDC token — so an engine can integrate
with `fetch` alone and no new dependency. Prefer that for the reference example.

## Does the port generalize?

| Broker | Per-end-user handle | Fits `CredentialSource` |
| --- | --- | --- |
| Vercel Connect | `subject: { type: "user", id }` | Yes |
| Nango | `connectionId` | Yes |
| Composio | entity id | Yes |
| WorkOS Connect | user or organization | Yes |
| Vault / AWS Secrets Manager | none; TTL lease | Yes, ignoring `principal` |
| Plain environment variable | none | Yes, the static implementation |

All six reduce to `get({ principal, signal }) => Credential`. The differences
live in the composition root, which is exactly where `AE-ARCH-02` puts them.

## Staged plan

1. **Port and static implementation.** Introduce `CredentialSource` in one
   example and migrate its existing environment credential to
   `createStaticCredentialSource`. No behavior change; establishes the seam.
2. **Broker implementation.** Add a Vercel Connect source in the same example,
   covering app subject, user subject, the consent-required error, subject
   mapping, and cancellation. Test against a local broker stub that never calls
   the public API, matching the `firecrawl-stub.ts` convention.
3. **Recipe.** `recipes/connector-broker.mdx` beside `external-provider.mdx`,
   plus an entry in `docs/README.md`. The `recipes/auth/` family covers inbound
   identity; this is the outbound counterpart and should say so.
4. **ADR.** Promote this note once steps 1–3 land, recording the boundary and
   the error mapping as the compatibility surface.

**Not now:** an optional `@invokta/connect` package. Per `AE-SCOPE-04` and the
precedent in ADR 0024, that requires evidence from at least three independently
deployed engines across at least two distinct brokers, a stable port across
those engines, a threat model covering token cache isolation and consent-URL
handling, and named security-maintenance ownership.

## Open questions

- Does the adapter receive `principal` as a call argument, or does the
  capability resolve the credential and hand the adapter a value? The first
  keeps the port honest about needing identity; the second keeps the adapter
  free of `Principal`. Decide in step 1 and apply it consistently.
- Should the consent-required `publicDetails` shape be normative across engines
  so MCP clients can recognize it, or stay engine-local until a second engine
  needs it? `AE-SCOPE-04` argues for engine-local first.
- `@vercel/connect` also ships framework adapters. They target inbound identity
  libraries and belong to the `recipes/auth/` axis, not this one; confirm before
  the recipe conflates them.

## Sources

Vercel's documentation was not directly reachable from the authoring
environment, so the SDK details above come from Vercel's public docs index,
changelog, and published plugin skill. Confirm exact signatures against
[the Connect SDK reference](https://vercel.com/docs/connect/ts-sdk-reference)
before implementing step 2.
