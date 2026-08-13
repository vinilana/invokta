# Deployment Runbook

## 1. Preflight

Confirm the target and topology before writing:

```sh
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
ss -ltnp
docker compose version
```

Decide:

- Use bundled Caddy when ports 80 and 443 are free.
- Use `compose.hostinger.yaml` when an existing Traefik owns 80 and 443.
- Set a unique `APP_TRAEFIK_ROUTER_PREFIX` for every project on shared Traefik.

The Hostinger override does not declare an external Traefik network. Inspect
the running proxy before activation:

- A bridged Traefik must share a verified Docker network with `engine` and
  `auth`, and that attachment must survive proxy recreation.
- A host-networked Traefik may reach Docker bridge addresses through host
  routing; prove the actual route instead of adding a guessed network.
- Use the merged Compose output and container inspection as the source of
  truth. Do not invent `traefik.docker.network` labels or external networks.

Run locally before packaging:

```sh
npm ci
npm run check
docker compose --env-file .env.example -f compose.yaml config --quiet
docker compose --env-file .env.example -f compose.yaml -f compose.hostinger.yaml config --quiet
```

## 2. Configure secrets

Create `.env` on the target with mode 600. Set:

- `POSTGRES_PASSWORD`;
- matching credentials in `DATABASE_URL` when host-side commands use it;
- `APP_PUBLIC_URL` as the final HTTPS origin without a path;
- `APP_PUBLIC_HOST` as the hostname only;
- Traefik router prefix and certificate resolver when applicable.

Never package or transfer `.env`. Do not persist
`INVOKTA_OAUTH_BOOTSTRAP_PASSWORD` on the VPS.

## 3. Back up and tag rollback

Create a database backup before migration:

```sh
mkdir -p backups
docker compose exec -T postgres pg_dump -U invokta_app invokta_app | gzip > backups/pre-deploy.sql.gz
chmod 600 backups/pre-deploy.sql.gz
```

Use the actual configured database name and user when customized.

Preserve the running image:

```sh
docker image tag auth-self-hosted-oauth-engine:local auth-self-hosted-oauth-engine:rollback-PREVIOUS_VERSION
```

Record the image ID and backup path in the deployment notes.

## 4. Transfer source only

Include:

- `src/`;
- `migrations/`;
- package manifests and TypeScript config;
- Dockerfile and Compose files;
- Caddyfile;
- Invokta manifests.

Exclude:

- `.env` and credentials;
- `.git`;
- `node_modules` and `dist`;
- logs, coverage, backups, and database files.

Extract over the application directory without replacing its `.env` or named
volumes.

## 5. Validate and build

Bundled Caddy:

```sh
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml build migrate auth engine
```

Existing Traefik:

```sh
docker compose -f compose.yaml -f compose.hostinger.yaml config --quiet
docker compose -f compose.yaml -f compose.hostinger.yaml build migrate auth engine
```

Stop if configuration or build fails. The running image remains available for
rollback.

## 6. Activate

Bundled Caddy:

```sh
docker compose -f compose.yaml up -d --no-build
```

Existing Traefik:

```sh
docker compose -f compose.yaml -f compose.hostinger.yaml up -d --no-build
```

Compose waits for PostgreSQL, runs migration once, starts OAuth, and then starts
the engine. Do not delete or recreate named volumes.

## 7. Bootstrap only a new installation

Check whether the owner already exists before bootstrap. For a confirmed new
database:

```sh
docker compose run --rm auth node dist/oauth/bootstrap-owner.js
```

Enter the owner email and password interactively. Bootstrap must fail on an
existing owner. Changing an environment variable later does not change the
stored password hash.

## 8. Verify

```sh
docker compose ps -a
docker compose logs --tail=100 migrate auth engine
npm run deploy:probe -- --url https://mcp.example.com/mcp --expect alive
npm run deploy:inspect-oauth -- --url https://mcp.example.com/mcp
npm run oauth:probe-dcr -- --url https://mcp.example.com
```

Confirm:

- migration exited 0;
- OAuth and engine are healthy with zero unexpected restarts;
- public protected-resource metadata, OAuth discovery, and JWKS respond;
- DCR returns 201 and cleanup returns 204;
- one fresh browser login and consent reaches the client callback;
- `/token` succeeds;
- an authenticated MCP request succeeds.

Do not declare an OAuth integration complete after metadata checks alone.

## 9. Roll back

If the new image is unhealthy:

1. Point the Compose image tag to `rollback-PREVIOUS_VERSION`.
2. Recreate `auth` and `engine` without deleting volumes.
3. Verify health and public probes.
4. Restore PostgreSQL only when a migration is incompatible and the backup
   matches the rollback image.

Never use `docker compose down -v` for a routine rollback.

## 10. Handoff

Record:

- deployed version and image ID;
- proxy topology and public URL;
- backup path and permissions;
- rollback image tag;
- container health and restart counts;
- probe results;
- whether real callback, token exchange, and MCP invocation were verified;
- any remaining client-side eligibility or configuration requirement.
