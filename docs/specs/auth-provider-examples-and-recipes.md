# Authentication provider examples and recipes plan

- Status: Proposed
- Date: 2026-08-05
- Affected areas: `examples/`, `apps/docs` (recipes, guides, examples catalog),
  `docs/http-authentication.md`, root `README.md`
- Unaffected contracts: `@invokta/core`, `@invokta/mcp`, and every other
  package keep their current public API. This plan is additive documentation
  and example code only.

## Summary

Invokta deliberately ships no identity system. `@invokta/mcp` accepts a
pluggable `auth.authenticate` hook that converts a verified request identity
into the minimal `Principal`, and `@invokta/core` applies capability `access`
rules on every channel. The framework docs
([`docs/http-authentication.md`](../http-authentication.md),
[`docs/capability-authorization.md`](../capability-authorization.md), ADR 0007)
describe this boundary in provider-neutral terms, and the only runnable
authentication example today is the static bearer token in
[`examples/support-engine/src/mcp-http.ts`](../../examples/support-engine/src/mcp-http.ts).

Engine authors keep asking the same practical question: "How do I plug in the
auth I already have?" This plan answers it with **one recipe per provider**,
each backed by its own self-contained runnable example: Supabase, Clerk,
Auth0, Firebase Auth, AWS Cognito, Better Auth, Auth.js (NextAuth), WorkOS,
plus provider-neutral JWT-bearer, API-key, and MCP OAuth discovery recipes.
Every recipe can be read, run, and copied on its own without touching the
others.

## Goals

- Give one recipe per provider, each pairing a docs page with its own
  runnable example package, so an engine author who uses exactly one provider
  copies exactly one unit.
- In each recipe, provide a copyable composition-root adapter that verifies
  that provider's credential and maps it to `Principal`.
- Cover the three integration surfaces an engine author actually has:
  1. the MCP HTTP boundary (`serveMcpHttp` `auth.authenticate` hook);
  2. embedded direct invocation, where a host application (for example a
     Next.js route handler) already resolved a session and passes a principal
     to `engine.invoke`;
  3. local channels (CLI and MCP stdio), where identity comes from the local
     environment, referencing the existing `local-principal` pattern.
- Show, in every recipe, the split between authentication (hook → `Principal`)
  and authorization (capability `access` rule), linking to the existing
  domain-authorization recipe.
- Keep every recipe backed by runnable, offline-testable code, matching the
  recipes-index promise: "Each one uses code from a tested example."
- Preserve the secret and logging rules in `docs/http-authentication.md`
  (no tokens in `Principal`, `publicDetails`, events, or logs; fail closed;
  respect `request.signal`).

## Non-goals

- No identity, session, token issuance, or user-management feature in any
  `@invokta/*` package (ADR 0007 keeps the framework a Resource Server
  boundary).
- No new framework abstraction such as a `Verifier` interface exported from
  core or mcp; verifier ports remain application code defined per example.
- No shared `examples/auth-common` helper package: each example deliberately
  duplicates the small amount of shared boilerplate so it stays standalone
  and copy-able, in line with the "no speculative abstractions" rule.
- No Authorization Server behavior: no login, consent, refresh, or callback
  routes in examples.
- No live network calls in tests, and no real provider accounts, credentials,
  or secrets anywhere in the repository.
- No per-provider authorization models (roles, orgs, RBAC products); the
  recipes map verified claims into `Principal.attributes` and defer policy to
  the existing capability-authorization guidance.

## Current state

- `docs/http-authentication.md` documents the hook contract, Protected
  Resource Metadata, and the secret rules, with one provider-neutral
  `AccessTokenVerifier` sketch.
- `docs/capability-authorization.md` and the `recipes/domain-authorization`
  page cover the authorization half.
- `examples/support-engine` demonstrates `mode: "required"` with a static
  bearer token, and `local-principal.ts` for local channels.
- The docs site has an established recipe format
  (`apps/docs/src/content/docs/recipes/*.mdx` + card on `recipes/index.mdx` +
  sidebar entry in `apps/docs/astro.config.mjs`).

## Design constraints

These follow from ADR 0007 and the existing docs, and every deliverable must
respect them:

1. Provider SDKs and verification libraries live at the composition root of an
   example, never inside capability definitions. Capabilities see only
   `Principal`.
2. The `authenticate` hook returns a `Principal` for a valid credential,
   `null` for any invalid or missing credential, and throws only for
   authentication infrastructure failure (yielding a sanitized HTTP 500).
3. Principals carry only verified, authorization-relevant claims — never the
   raw token, full claim set, or live SDK objects.
4. Verifiers bound their own I/O with timeouts and observe `request.signal`.
5. Tests must run offline. JWT-based providers are tested by generating a
   local key pair with `jose` and serving a local JWKS
   (`createLocalJWKSet`), so signature verification is real without any
   network.
6. RED, GREEN, REFACTOR for all executable behavior; one validated, cohesive
   commit per deliverable; all content in English.

## Provider coverage

Each provider gets its own recipe, but two mechanical families keep the
recipes structurally consistent, so a reader who learned one recipe can
navigate the next:

| Family | Providers | Verification mechanism | Extra dependency |
| --- | --- | --- | --- |
| Hosted JWT issuers (JWKS) | Supabase Auth, Clerk, Auth0, AWS Cognito, WorkOS AuthKit | `jose` `createRemoteJWKSet` + `jwtVerify` with issuer/audience checks; each recipe also shows the provider SDK variant (`supabase.auth.getClaims`, `@clerk/backend` `verifyToken`, `aws-jwt-verify`, WorkOS SDK) | none required for the runnable path (`jose` only) |
| App-owned sessions (TS-native) | Better Auth (bearer/JWT plugin), Auth.js / NextAuth (JWT session or embedded), Firebase Auth (`firebase-admin` `verifyIdToken`) | session/token validated by the library the host already runs; MCP HTTP recipe uses the library's token form, embedded recipe passes the host session's principal to `engine.invoke` | shown in recipe prose; runnable tests use a fake verifier port |
| Provider-neutral | Generic OIDC/JWT bearer, static and hashed API keys (machine-to-machine), MCP OAuth discovery via `resourceMetadata` | `jose`, constant-time key comparison, Protected Resource Metadata | none |

Kinde, Logto, Stack Auth, and similar providers are deliberately deferred;
each is another JWKS issuer, and the Auth0/generic-OIDC recipe is written to
double as their template. Lucia is excluded because the project was
discontinued as a library.

## Deliverables

### 1. One self-contained example per provider

Each recipe is backed by its own example package under `examples/`, following
the naming of the existing domain-named examples:

| Example package | Backs recipe |
| --- | --- |
| `examples/auth-jwt-bearer-engine` | Generic OIDC/JWT bearer (the base recipe) |
| `examples/auth-supabase-engine` | Supabase Auth |
| `examples/auth-clerk-engine` | Clerk |
| `examples/auth-auth0-engine` | Auth0 / generic OIDC |
| `examples/auth-cognito-engine` | AWS Cognito |
| `examples/auth-firebase-engine` | Firebase Auth |
| `examples/auth-better-auth-engine` | Better Auth |
| `examples/auth-authjs-engine` | Auth.js / NextAuth |
| `examples/auth-workos-engine` | WorkOS AuthKit *(stretch)* |
| `examples/auth-api-key-engine` | API keys (machine-to-machine) |

Every example uses the same minimal template so the only meaningful diff
between two examples is the provider integration itself:

```text
examples/auth-<provider>-engine/
  src/
    engine.ts                 # engine with a minimal identity.whoami capability
    capabilities/whoami.ts    # access: "authenticated"; echoes safe principal data
    identity/
      verifier.ts             # this provider's credential verification
      principal.ts            # this provider's claims → Principal mapping
    mcp-http.ts               # serveMcpHttp entrypoint wiring the verifier
    embedded.ts               # direct engine.invoke with a host-derived principal
                              # (only in examples where the embedded surface
                              #  is the provider's primary usage, e.g. Auth.js)
  test/                       # offline tests for this provider's verifier
  README.md                   # how to run it against a real provider project
```

Key points:

- The `whoami` capability returns only data derived from `Principal` (id and
  selected attributes), which makes every recipe verifiable with `curl` or the
  MCP client and keeps the domain trivial on purpose.
- The small shared boilerplate (bearer parsing, the whoami capability) is
  duplicated per example rather than extracted, so each example remains a
  standalone, copy-able unit.
- Runnable dependencies stay minimal: `jose` plus workspace packages. SDK
  variants (Clerk, Supabase, `firebase-admin`, `aws-jwt-verify`, Better Auth)
  appear in recipe prose as drop-in replacements of the same verifier
  function, so the monorepo does not take on their install and audit weight
  (see Open questions if full SDK parity is preferred).
- The MCP OAuth discovery recipe does not need its own example; it runs the
  `resourceMetadata` walkthrough against `auth-jwt-bearer-engine`.
- Per example, tests mint tokens in that provider's claim shape from a
  locally generated key pair and assert: valid token → principal with
  expected attributes; expired, wrong issuer, wrong audience, malformed, or
  missing token → `null` → HTTP 401; verifier infrastructure failure →
  HTTP 500; no token material appears in principals or logs.

### 2. One docs-site recipe per provider: `apps/docs/src/content/docs/recipes/auth/`

A nested "Authentication" group under Recipes, one page per provider:

| Page | Content |
| --- | --- |
| `auth/index.mdx` | Decision guide: which surface (HTTP hook, embedded, local), which family; the authn/authz split; links to the normative guides and to each provider recipe |
| `auth/jwt-bearer.mdx` | The base recipe: `jose` JWKS verification in the `authenticate` hook, claims → `Principal`, failure semantics (401 vs 500) |
| `auth/supabase.mdx` | Supabase asymmetric JWTs: project JWKS URL, `sub`/`role`/`app_metadata` mapping, `getClaims` SDK variant |
| `auth/clerk.mdx` | `@clerk/backend` `verifyToken` and the JWKS variant; session vs machine tokens; `azp` checks |
| `auth/auth0.mdx` | Auth0 API audience setup, scope claims → attributes; also serves as the template for any generic OIDC provider (Kinde, Logto, …) |
| `auth/firebase.mdx` | `firebase-admin` `verifyIdToken` behind the verifier function; emulator-based local verification note |
| `auth/cognito.mdx` | `aws-jwt-verify` or jose; user-pool issuer shape, `token_use`, group claims |
| `auth/better-auth.mdx` | Better Auth bearer/JWT plugin for the HTTP hook; session-based embedded variant |
| `auth/authjs.mdx` | Auth.js/NextAuth: embedded pattern (route handler resolves session, passes principal to `engine.invoke`); JWT strategy for the HTTP hook |
| `auth/workos.mdx` | AuthKit JWKS, organization claims for multi-tenant attributes *(stretch)* |
| `auth/api-keys.mdx` | Machine-to-machine: hashed key sets, constant-time comparison, key → service principal; upgrades the support-engine static-token pattern |
| `auth/mcp-oauth-discovery.mdx` | `resourceMetadata`, the well-known document, Bearer challenge, and connecting an OAuth-capable MCP client end to end |

Each page follows the existing recipe format (frontmatter, `Steps`, code from
its own tested example, "Run and verify" section) and ends with the same two
links: capability authorization for the policy half, and the secret rules.

### 3. Wiring and cross-links

- Register the "Authentication" sidebar group in
  `apps/docs/astro.config.mjs` with one entry per provider recipe.
- Add an "Authenticate requests" card to `recipes/index.mdx` linking to
  `auth/index.mdx`, which lists every provider (one card per provider would
  drown the existing grid; the group index is the per-provider directory).
- Add each `auth-<provider>-engine` example to the examples catalog
  (`apps/docs/src/content/docs/examples/index.mdx`) and the root `README.md`
  example list, grouped under one "Authentication" heading so the catalog
  stays scannable.
- Add a short "Provider recipes" pointer section to
  `docs/http-authentication.md` and the mirrored
  `guides/http-authentication.mdx` so the normative guide stays neutral but
  discoverable from.

## Delivery phases

One provider per phase; each phase ships that provider's example, tests,
recipe page, and wiring as one cohesive, validated commit, leaving
`yarn run check` green and the docs site building:

1. **Foundation: generic JWT bearer** — `auth-jwt-bearer-engine` (the
   template every later example copies), the offline local-JWKS test
   approach, recipes `auth/index.mdx` and `auth/jwt-bearer.mdx`, sidebar
   group, catalog and README wiring.
2. **Supabase** — `auth-supabase-engine`, tests, `auth/supabase.mdx`.
3. **Clerk** — `auth-clerk-engine`, tests, `auth/clerk.mdx`.
4. **Auth0 / generic OIDC** — `auth-auth0-engine`, tests, `auth/auth0.mdx`.
5. **AWS Cognito** — `auth-cognito-engine`, tests, `auth/cognito.mdx`.
6. **Firebase Auth** — `auth-firebase-engine`, tests with a fake verifier,
   `auth/firebase.mdx`.
7. **Better Auth** — `auth-better-auth-engine` with bearer-plugin HTTP
   variant and embedded variant, tests, `auth/better-auth.mdx`.
8. **Auth.js / NextAuth** — `auth-authjs-engine` with the embedded pattern
   and JWT-strategy variant, tests, `auth/authjs.mdx`.
9. **API keys (machine-to-machine)** — `auth-api-key-engine`, tests,
   `auth/api-keys.mdx`, cross-link from the support-engine README.
10. **MCP OAuth discovery** — `resourceMetadata` walkthrough against
    `auth-jwt-bearer-engine`, `auth/mcp-oauth-discovery.mdx`.
11. **WorkOS AuthKit** *(stretch)* — `auth-workos-engine`, tests,
    `auth/workos.mdx`.
12. **Polish** — final pass over the recipes index, README, changelog entry,
    and link check.

Phases 2–9 are independent of each other and only depend on phase 1, so their
order can change or they can be parallelized.

## Acceptance criteria

- `yarn run check` passes from the repository root with every new example
  included; no test performs network I/O or needs a provider account.
- Every provider has exactly one recipe page and one backing example; each
  recipe compiles in the docs build, appears in the "Authentication" sidebar
  group, and every code block corresponds to code in its own example (or is
  explicitly marked as a provider-SDK variant of a shown verifier).
- Each example runs standalone: its README's run-and-verify steps require
  only that example, the repository root install, and (for a live check) a
  real project of that provider.
- For each verifier, tests cover: valid credential → expected `Principal`;
  each invalid-credential class → `null`/401; infrastructure failure → 500;
  and that no credential material reaches `Principal`, error details, or logs.
- No `@invokta/*` package gains a new export, dependency, or contract change.
- The support-engine and existing docs keep working; new content links into
  them rather than duplicating them.

## Open questions

1. **SDK parity vs. lean dependencies.** Should each runnable example depend
   on its real provider SDK (`@supabase/supabase-js`, `@clerk/backend`,
   `firebase-admin`, `aws-jwt-verify`, `better-auth`) so the recipes are
   copy-exact, at the cost of install and audit weight in the monorepo? The
   plan currently recommends `jose`-only runnable code with SDK variants in
   prose.
2. **Provider cut line.** Is WorkOS in or out of the first release, and should
   any deferred provider (Kinde, Logto, Stack Auth, Firebase App Check) be
   promoted to its own recipe?
