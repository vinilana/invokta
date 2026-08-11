# Customization Guide

## 1. Rename the project identity

Replace `auth-self-hosted-oauth-engine` with the project slug in:

- `package.json` and the lockfile created by the selected package manager
- `src/engine.ts`
- `src/bin.ts`
- `invokta.mcp.json`
- `compose.yaml`

Set a unique `APP_TRAEFIK_ROUTER_PREFIX` in `.env` instead of hard-coding
router names when several services share one Traefik instance.

## 2. Define domain capabilities

Use `src/capabilities/whoami.ts` as the shape reference. Every capability
must declare:

- a stable domain-oriented ID;
- title and description;
- input and output schemas;
- authenticated or public access;
- timeout;
- read-only, destructive, idempotent, and open-world annotations;
- observable errors.

Put business logic in capabilities and injected dependencies. Keep
`src/direct.ts`, `src/cli.ts`, `src/mcp-stdio.ts`, and `src/mcp-http.ts` as thin
adapters. Every channel must use `engine.invoke`; never call `run` directly.

Register literal capability IDs in `src/engine.ts` and mirror them in
`invokta.mcp.json`.

Use `$add-invokta-capability` for this workflow. The project-local skill forces
the contract and failing engine test to be established before implementation.

## 3. Add domain persistence

OAuth owns `migrations/001_oauth.sql`. Start application migrations at
`002_domain.sql`, add the filename to `src/database/migrate.ts`, and make each
migration idempotent and transactional.

Keep repositories behind engine-owned interfaces. Apply the authenticated
principal ID as an ownership boundary in every domain query that stores
per-user data.

## 4. Add external providers

Read provider credentials only in the provider composition root. Do not return
keys from capabilities or include them in errors. Add required environment
names to Compose, `.env.example`, `invokta.deploy.json`, and relevant tests.

## 5. Preserve the OAuth contract

Do not weaken these defaults while adding application behavior:

- Authorization Code plus mandatory PKCE;
- DCR with ES256 and a confidential-client default;
- CIMD disabled until an SSRF-resistant metadata fetch policy is available;
- `client_secret_post` support for clients that explicitly register it;
- rotating refresh tokens;
- JWT access tokens with the exact MCP audience and `mcp:tools` scope;
- fail-closed authentication;
- no public user registration;
- callback redirect chains limited to HTTPS or exact HTTP loopback origins;
- sanitized logs.

Use `$maintain-mcp-oauth` for any change under `src/oauth`,
`src/oauth-server.ts`, or `src/http-auth.ts`. Read
`docs/OAUTH_ARCHITECTURE.md` before changing public metadata or token policy.

## 6. Extend tests before implementation

Follow RED, GREEN, REFACTOR. At minimum, test:

- unauthenticated denial at `engine.invoke`;
- valid behavior at `engine.invoke`;
- invalid input and denied ownership;
- dependency failure and cancellation where applicable;
- fail-closed HTTP authentication;
- OAuth metadata whenever provider configuration changes.

Finish with:

```sh
npm run check
docker compose config --quiet
docker compose -f compose.yaml -f compose.hostinger.yaml config --quiet
```

Use `$deploy-mcp-oauth-vps` and `docs/DEPLOYMENT_RUNBOOK.md` for production
deployment, verification, and rollback.
