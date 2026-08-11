---
name: maintain-mcp-oauth
description: Diagnose, test, and change the self-hosted OAuth layer for this MCP service while preserving PKCE, DCR, ES256 tokens, rotating refresh tokens, secure consent, sanitized logs, and fail-closed resource authentication. Use for OAuth login or consent failures, Gemini connection problems, DCR metadata errors, token exchange failures, callback/CSP issues, issuer or audience mismatches, refresh behavior, and changes under src/oauth or src/http-auth.ts.
---

# Maintain MCP OAuth

Resolve the project root as three directories above this `SKILL.md`. Perform
all relative reads and commands from that root; do not diagnose a neighboring
project merely because it is the caller's current working directory.

## Build evidence first

1. Read `AGENTS.md`, `docs/OAUTH_ARCHITECTURE.md`, and
   `docs/OAUTH_TROUBLESHOOTING.md` completely.
2. Read the affected source and tests under `src/oauth`, `src/http-auth.ts`,
   `src/oauth-server.ts`, `test/oauth-provider.test.ts`,
   `test/oauth-server.test.ts`, and `test/http-auth.test.ts`.
3. Separate the browser interaction, authorization endpoint, callback, token
   exchange, and MCP request into distinct stages.
4. Use sanitized logs and artifact counts or non-secret metadata. Never print
   passwords, cookie values, client secrets, registration access tokens,
   authorization codes, PKCE verifiers, state, or interaction IDs.

## Diagnose safely

- Probe discovery, protected-resource metadata, and JWKS without credentials.
- Use `npm run oauth:probe-dcr -- --url ORIGIN` for DCR; it removes its client.
- Use only a callback on a controlled origin for automated browser-flow tests.
- Do not use the owner's credentials to authorize a client with an external
  callback unless the user explicitly approves that sensitive flow.
- Treat an authorization code with no `/token` request as a callback/client
  problem, not a password or consent persistence problem.
- Treat a second submit on the same interaction as stale; diagnose the first
  submit instead of weakening interaction replay protection.

## Preserve invariants

- Keep Authorization Code and mandatory S256 PKCE.
- Keep DCR defaults on ES256 and a confidential client authentication method.
- Continue accepting explicitly registered `client_secret_post` clients.
- Validate access-token signature, issuer, audience, subject, and `mcp:tools`.
- Keep refresh-token rotation and bounded token lifetimes.
- Keep the single-owner model without public registration.
- Limit consent redirect chains to HTTPS or exact HTTP loopback callbacks.
- Keep authentication fail-closed during metadata, JWKS, or database failure.
- Persist users, keys, clients, grants, sessions, and tokens together.

## Change with executable proof

1. Add a regression test that fails for the observed protocol behavior.
2. Implement the smallest provider, interaction, diagnostics, or verifier
   change that passes.
3. Test the negative security case and secret-redaction behavior.
4. Update OAuth documentation when metadata or public behavior changes.
5. Run `npm run check` and both Compose validations.
6. Deploy only when the user's request includes deployment.

Report the failing stage, root cause, protocol-visible change, security
invariants retained, and the exact live verification still required.
