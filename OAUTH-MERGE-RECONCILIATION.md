# Reconciling `feat/devtools-enhance` with main's OAuth integration

Transient working document. Delete it once the reconciliation lands.

## What happened

`origin/main` gained 17 commits, including the whole
`feat/mcp-oauth-framework-integration` branch (PR #35) and the Windows
installer ownership fix (PR #41). Both landed on 2026-08-13, the same day this
branch built its OAuth work, and the two efforts overlap substantially.

`git merge origin/main` stops with seven conflicts. It was aborted rather than
half-resolved, because three of the seven encode decisions that belong here
rather than in a conflict marker. The branch is unchanged at `83cf8f1`.

Nothing on this branch is wasted, but three pieces are now redundant or
contradictory, and one collision is structural.

## 1. Two ADR 0027s — structural, fix first

The tree merges to two files claiming the same number:

| Ours | Main's |
| --- | --- |
| `0027-adapter-emulation-in-engine-devtools.md` | `0027-windows-installer-ownership-identity.md` |

Git did not flag it: the filenames differ, so both simply arrive. Main also
took `0024` (production MCP OAuth integration boundary) and `0026` (generated
engine MCP conformance gate), so main now owns 0024 through 0027 and this
branch must move up by one:

| Now | Becomes |
| --- | --- |
| 0027 adapter emulation | **0028** |
| 0028 selectable HTTP authentication | **0029** |
| 0029 project entry points | **0030** |
| 0030 OAuth discovery and advertised servers | **0031** |

Renumber the four files, their `# ADR NNNN:` headings, and every reference:
`docs/adr/README.md`, `docs/README.md`, `CHANGELOG.md`,
`packages/devtools/README.md`, `apps/docs/src/content/docs/reference/devtools.mdx`,
`packages/devtools/src/adapter-runner.ts`, and
`packages/devtools/src/playground-oauth.ts`. Grep for `ADR 002[789]` and
`ADR 0030` to catch the rest.

## 2. Two OAuth discovery inspectors — the real decision

Main added `invokta-deploy inspect-oauth`
(`packages/deploy/src/oauth-inspection/inspect.ts`, 471 lines) at the same time
this branch added `inspectMcpOAuth` (`packages/mcp/src/client.ts`). They solve
the same problem differently:

| | main's `inspectOAuthDiscovery` | ours `inspectMcpOAuth` |
| --- | --- | --- |
| Package | `@invokta/deploy` | `@invokta/mcp` |
| Shape | fail-fast: one `stage` + `reason` | every leg reported with its own outcome, hint, and detail |
| Covers | challenge, PRM, OAuth/OIDC discovery, PKCE, registration readiness, **JWKS** | challenge, PRM, RFC 8414 metadata, registration advertised |
| Surface | CLI, for homologation | library, rendered by the devtools **Check** action |

Both are sanctioned by ADR 0024, which explicitly permits deploy "a separately
named, bounded, read-only OAuth discovery inspection operation" and keeps
"interactive end-to-end authorization … through the existing `@invokta/mcp`
client facade and Invokta devtools". So neither is out of charter, and 0024
does not contradict our client-side change.

**The devtools cannot simply reuse main's.** ADR 0021 requires that devtools
depend on no other supporting package, so `devtools → deploy` is not available.
The choice is therefore real:

- **Consolidate in `@invokta/mcp` (recommended).** Port main's extra stages —
  challenge scopes, JWKS validation, registration readiness — into the per-leg
  report, and reduce `packages/deploy/src/oauth-inspection/` to a renderer over
  `inspectMcpOAuth`. One implementation of protocol knowledge, inside the
  package ADR 0006 puts it in; both surfaces keep working; the deploy CLI gains
  per-leg output. Costs an ADR superseding part of 0024's deploy clause, and
  rewrites code merged days ago.
- **Keep both.** Zero merge risk and no ADR. Leaves two inspectors drifting,
  which the repository's own "evolution by extraction" rule exists to prevent.

Decide this before touching the code; everything else in this document is
mechanical.

## 3. The loopback carve-out — same intent, different rule

Both branches independently relaxed `validateAuthorizationServerUrl` in
`packages/mcp/src/http.ts`, and the semantics differ:

- **Ours**: a loopback HTTP authorization server is accepted when the resource
  is itself loopback HTTP.
- **Main's**: accepted only at *the exact same loopback origin* as the
  resource.

Main's is stricter and is already released; ours is what the OAuth fixtures
need, because the fixture provider deliberately runs on a **different** loopback
origin than the engine, which is the topology a real identity provider has.

Take main's rule as the baseline and decide deliberately whether the fixture
topology justifies widening it to any loopback origin. If it does, that widening
belongs in the renumbered ADR 0031 with its own reasoning; if it does not, the
OAuth fixtures must be restructured to share one origin. Resolve
`packages/mcp/src/http.ts` and `packages/mcp/test/http.test.ts` accordingly,
keeping both test tables.

## 4. Two end-to-end OAuth proofs

Main added `packages/devtools/test/self-hosted-oauth.integration.test.ts` (392
lines): a real `oidc-provider` with `jose`, driving
`createAttachedSessionController` against
`examples/auth-self-hosted-oauth-engine`, including a reverse-proxy simulation.

This branch added `oauth-flow.integration.test.mjs` with a hand-rolled
`oauth-provider.mjs` fixture (~460 lines).

They overlap on "an authorization completes and a tool call carries the derived
principal". They do not overlap on everything: ours is dependency-free and fast,
and it is the only one exercising a **cross-origin** authorization server and
the per-leg inspection report. Main's proves the shipped example against a real
provider.

Keep both, but narrow ours to what only it covers — the inspection report and
the cross-origin topology — and drop assertions main's test already makes
better. If the loopback rule in §3 stays strict, our fixture pair may collapse
into main's example instead, which would remove the hand-rolled provider
entirely.

## 5. Documentation conflicts — mechanical

Resolve by keeping both sides' content:

- `CHANGELOG.md` — both added `### Added` blocks; concatenate, renumber our ADR
  references.
- `docs/adr/README.md`, `docs/README.md` — both appended rows and links.
- `docs/scope-and-limits.md` — main rewrote the `@invokta/deploy` and
  `@invokta/devtools` responsibility rows; ours added three limit rows. Keep
  main's responsibility text, re-apply our devtools row on top of it, keep our
  limit rows.
- `apps/docs/…/recipes/auth/mcp-oauth-discovery.mdx` — main rewrote the
  validation-rule bullet; take main's wording, keep our new "Check the chain"
  section.

## Order

1. Renumber our four ADRs on this branch (§1), commit.
2. Decide §2 and §3 with the user; record whichever needs an ADR.
3. Merge `origin/main`, resolving §3 and §5.
4. Apply the §2 decision.
5. Narrow the tests per §4.
6. `yarn run check`, then the live validation the devtools README describes.

## What this branch keeps regardless

The client-side trust change is not duplicated anywhere in main: main relaxed
only the resource server's advertisement rules, so `isAllowedOAuthEndpoint`
still pins every OAuth endpoint to the resource's origin on main. Lifting that
— so a hosted identity provider on another origin can be reached at all — is
this branch's alone, and ADR 0024 points at exactly this path for interactive
authorization. Adapter emulation, the identity and authentication split, project
entry points, and the Test identities work have no counterpart in main.
