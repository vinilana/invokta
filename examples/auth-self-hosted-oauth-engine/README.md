# Self-hosted OAuth engine

A production-oriented Invokta example exposed over
MCP Streamable HTTP with a self-hosted OAuth 2.1 authorization server. Direct,
CLI, MCP stdio, and MCP HTTP entry points all invoke capabilities through the
same `engine.invoke` boundary.

The example contains no application data, provider keys, or owner credentials.
Replace the authenticated `identity.whoami` capability with your domain
capabilities after importing it into a standalone project.

## Included

- Authorization Code with mandatory PKCE.
- Dynamic Client Registration. Client ID Metadata Documents remain disabled
  until the Authorization Server has an SSRF-resistant metadata fetch policy.
- Gemini-compatible confidential client defaults: ES256 ID tokens and
  `client_secret_basic`; registered clients may explicitly choose
  `client_secret_post`.
- JWT ES256 access tokens restricted to the MCP resource and `mcp:tools` scope.
- Rotating refresh tokens with a 30-day lifetime.
- Explicit owner login and consent with no public sign-up endpoint.
- PostgreSQL persistence for users, clients, grants, sessions, tokens, cookie
  keys, and signing keys.
- Fail-closed issuer, audience, subject, signature, and scope validation.
- Sanitized OAuth diagnostics that never log interaction IDs, codes, tokens,
  client secrets, passwords, or error details.
- Bundled Caddy deployment and an override for hosts that already run Traefik.
- Read-only containers, dropped capabilities, health checks, ordered
  migrations, and bounded Docker logs.
- Regression tests for authentication, DCR defaults, callback CSP, password
  hashing, database configuration, and the shared engine boundary.

## Requirements

- Node.js 22.20 or newer
- Docker Engine with Docker Compose v2
- A public DNS name for production
- Free inbound TCP ports 80 and 443 when using bundled Caddy

## Create a standalone project

Import this official example with the Invokta creator, then follow
[CUSTOMIZE.md](CUSTOMIZE.md):

```sh
npm create invokta-engine@latest my-mcp-service -- --example auth-self-hosted-oauth-engine
cd my-mcp-service
```

Keep the `APP_*` environment names unless the application has a strong reason
to rename them. They are intentionally generic so the OAuth stack can be reused
without another mechanical rewrite.

## Project-local agent skills

Every project imported from this example carries three skills under
`.agents/skills`:

| Skill | Use it for |
| --- | --- |
| `$develop-invokta-project` | Change capabilities and adapters through the shared `engine.invoke` boundary |
| `$add-invokta-capability` | Add domain actions, dependencies, migrations, and engine-level tests |
| `$maintain-mcp-oauth` | Diagnose or change DCR, login, consent, callbacks, tokens, or MCP authentication |
| `$deploy-mcp-oauth-vps` | Deploy, upgrade, verify, or roll back the stack with Caddy or Traefik |

Invoke a skill explicitly when the task crosses a security or deployment
boundary. Compatible agents may also select them automatically from their
descriptions.

Supporting references:

- [OAuth architecture](docs/OAUTH_ARCHITECTURE.md)
- [OAuth troubleshooting](docs/OAUTH_TROUBLESHOOTING.md)
- [Deployment runbook](docs/DEPLOYMENT_RUNBOOK.md)
- [Production checklist](docs/PRODUCTION_CHECKLIST.md)

## Configure production

Create the environment file:

```sh
cp .env.example .env
chmod 600 .env
```

At minimum, replace these values:

```dotenv
POSTGRES_PASSWORD=replace-with-a-long-random-password
DATABASE_URL=postgresql://invokta_app:replace-with-the-same-password@127.0.0.1:5432/invokta_app
APP_PUBLIC_URL=https://mcp.example.com
APP_PUBLIC_HOST=mcp.example.com
```

`DATABASE_URL` and `POSTGRES_PASSWORD` must contain the same database password.
Do not add `INVOKTA_OAUTH_BOOTSTRAP_PASSWORD` to a committed or persistent
production environment file.

## Deploy with bundled Caddy

Point the public hostname to the VPS and confirm ports 80 and 443 are free.
Then run:

```sh
docker compose up -d --build
docker compose run --rm auth node dist/oauth/bootstrap-owner.js
docker compose ps
docker compose logs -f proxy auth engine
```

The bootstrap command prompts for the only owner's email and password. The
password must contain at least 12 characters. Bootstrap fails after an owner
already exists, and the database stores only a password hash.

The public MCP URL is:

```text
https://mcp.example.com/mcp
```

## Deploy on Hostinger or another existing Traefik host

Do not start bundled Caddy when Traefik already owns ports 80 and 443. Set a
unique router prefix in `.env` when multiple projects share the host:

```dotenv
APP_PUBLIC_URL=https://mcp.example.com
APP_PUBLIC_HOST=mcp.example.com
APP_TRAEFIK_ROUTER_PREFIX=my-mcp-service
```

Then apply both Compose files:

```sh
docker compose -f compose.yaml -f compose.hostinger.yaml up -d --build
docker compose -f compose.yaml -f compose.hostinger.yaml run --rm auth node dist/oauth/bootstrap-owner.js
docker compose -f compose.yaml -f compose.hostinger.yaml ps
```

The override disables the `proxy` service unless the `bundled-caddy` profile is
explicitly enabled. It gives `/mcp` and the protected-resource metadata a
higher-priority router to the engine; every other public path goes to the OAuth
service.

## Validate OAuth before connecting a client

Check service health and Dynamic Client Registration:

```sh
docker compose ps
npm run deploy:probe -- --url https://mcp.example.com/mcp --expect alive
npm run oauth:probe-dcr -- --url https://mcp.example.com
```

The DCR probe creates a temporary client, verifies the safe defaults, does not
print its ID or secret, and deletes it immediately.

For Gemini custom connected apps, enter only the MCP URL first:

```text
https://mcp.example.com/mcp
```

Leave the manual client ID and client secret fields empty while DCR is enabled.
After owner login, approve the consent once and allow the callback time to
finish. If the browser remains on a consumed interaction, start a new
authorization instead of submitting the old consent form again.

Gemini custom apps are an evolving product with account, region, language, and
activity-history eligibility requirements. Verify the current requirements in
Google's official documentation when the server creates an authorization code
but the client never calls `/token`.

## Local development

For a standalone imported project, install dependencies, configure `.env`,
start PostgreSQL, and validate:

```sh
npm install
docker compose up -d postgres
npm run db:migrate
npm run check
```

Use a loopback origin for local OAuth development:

```dotenv
APP_PUBLIC_URL=http://127.0.0.1:3001
```

Run individual entry points:

```sh
npm run direct
npm run cli -- list
npm run cli -- run identity.whoami --input '{}'
npm run mcp:stdio
npm run oauth:serve
npm run mcp:http
```

The local direct, CLI, and stdio principal defaults to `local:user` and can be
changed with `APP_PRINCIPAL_ID`. HTTP always requires a verified credential.

## OAuth routing

| Route | Service |
| --- | --- |
| `/mcp` | Engine |
| `/.well-known/oauth-protected-resource/mcp` | Engine |
| `/.well-known/openid-configuration` | OAuth |
| `/.well-known/oauth-authorization-server` | OAuth |
| `/jwks`, `/auth`, `/token`, `/reg`, `/revoke` | OAuth |
| `/interaction/*` | OAuth |

## Security invariants

- Never make HTTP authentication optional in production.
- Never share one static Bearer credential as the default mode.
- Never expose PostgreSQL, engine port 3000, or OAuth port 3001 publicly.
- Preserve the OAuth database during deploys and restores; it contains both
  account state and signing keys.
- Back up the database before migrations and retain the previous image tag for
  rollback.
- Keep PKCE required and validate issuer, audience, subject, and `mcp:tools`.
- Do not log submitted OAuth metadata, passwords, codes, tokens, or secrets.
- Treat callback CSP changes as authentication changes and cover them with
  browser-oriented regression tests.

See [docs/PRODUCTION_CHECKLIST.md](docs/PRODUCTION_CHECKLIST.md) before the first
public deployment.

## Static Bearer compatibility mode

OAuth is the default. A legacy client can use a static credential only through
an explicit opt-in:

```dotenv
INVOKTA_HTTP_AUTH_MODE=bearer
INVOKTA_HTTP_BEARER_TOKEN=replace-with-at-least-32-random-characters
INVOKTA_HTTP_PRINCIPAL_ID=person:owner
INVOKTA_HTTP_ALLOWED_HOSTS=mcp.example.com,engine,localhost,127.0.0.1
```

This mode has no per-user consent, DCR, or refresh tokens.

## Verify inside the Invokta monorepo

From the repository root:

```sh
yarn workspace @invokta/example-auth-self-hosted-oauth test
yarn typecheck
```
