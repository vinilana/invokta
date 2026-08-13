---
name: deploy-mcp-oauth-vps
description: Deploy, upgrade, verify, or roll back this Docker Compose MCP OAuth stack on a VPS, including Hostinger environments with an existing Traefik proxy and hosts that use bundled Caddy. Use for production releases, new VPS setup, image rebuilds, environment configuration, database backup, owner bootstrap, health checks, public OAuth probes, rollback preparation, and deployment troubleshooting.
---

# Deploy MCP OAuth to a VPS

Resolve the project root as three directories above this `SKILL.md`. Perform
all local reads and commands from that root before inspecting any remote host.

## Choose the edge topology

1. Read `AGENTS.md`, `docs/DEPLOYMENT_RUNBOOK.md`, and
   `docs/PRODUCTION_CHECKLIST.md` completely.
2. Inspect the target before writing: running containers, Compose files,
   volumes, free ports, edge proxy, health, current image version, and `.env`
   key names without printing values.
3. Use `compose.yaml` when ports 80 and 443 are free for bundled Caddy.
4. Use `compose.yaml` plus `compose.hostinger.yaml` when Traefik already owns
   the edge. Set a unique `APP_TRAEFIK_ROUTER_PREFIX`.
5. Do not start a second edge proxy on occupied ports.
6. Derive networks and service reachability from the merged Compose output and
   the running proxy. Do not invent an external Traefik network when the files
   do not declare one.

## Prepare a recoverable release

- Run `npm run check` before packaging.
- Validate the selected Compose merge before building.
- Back up PostgreSQL before migrations and protect the backup permissions.
- Tag the current image with an explicit rollback version.
- Transfer only source, manifests, migrations, Compose files, and proxy config.
- Exclude `.env`, `.git`, `node_modules`, `dist`, logs, database files, and
  credentials from transfer packages.
- Preserve existing volumes and the remote `.env`.

## Deploy in dependency order

1. Build the `migrate`, `auth`, and `engine` image targets.
2. Start with `up -d --no-build` only after the build succeeds.
3. Wait for PostgreSQL, the one-shot migration, OAuth, and engine health.
4. Do not rerun owner bootstrap when an owner already exists.
5. Create the owner interactively only for a confirmed new deployment; never
   persist the bootstrap password on the VPS.

## Verify publicly

- Confirm container health, restart counts, and application versions.
- Review migration, auth, and engine logs for sanitized errors.
- Run the public MCP deployment probe.
- Verify protected-resource metadata, authorization discovery, and JWKS.
- Run the DCR probe and confirm temporary-client cleanup.
- Complete one real login, consent, callback, token exchange, and authenticated
  MCP request before declaring a new OAuth integration ready.

## Roll back safely

- Repoint the application image to the preserved rollback tag.
- Do not roll back the database unless the migration is incompatible and a
  matching pre-deploy backup is available.
- Recreate only affected services and verify health again.
- Never delete volumes as part of a routine rollback.

Report the deployed version, topology, backup, rollback tag, health, public
probes, and any manual client-flow verification that remains.
