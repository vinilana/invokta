# Production Checklist

## Identity and DNS

- [ ] `APP_PUBLIC_URL` is the final HTTPS origin with no path.
- [ ] `APP_PUBLIC_HOST` contains only the hostname.
- [ ] DNS resolves to the intended VPS.
- [ ] The deployment uses a unique Compose project and Traefik router prefix.

## Secrets and account bootstrap

- [ ] `.env` is mode 600 and excluded from version control.
- [ ] The PostgreSQL password is random and matches `DATABASE_URL`.
- [ ] The owner was created interactively over a trusted session.
- [ ] No bootstrap password remains in `.env`, Compose, shell history, or VPS
      process configuration.
- [ ] There is no public sign-up route.

## Network and containers

- [ ] Only ports 80 and 443 are public.
- [ ] PostgreSQL, engine 3000, and OAuth 3001 bind to loopback.
- [ ] Exactly one edge proxy owns ports 80 and 443.
- [ ] Containers are healthy, read-only, unprivileged, and capability-dropped.
- [ ] Docker log rotation is enabled.

## OAuth verification

- [ ] Protected-resource and authorization-server metadata are public.
- [ ] `npm run deploy:inspect-oauth -- --url <mcp-url>` succeeds.
- [ ] JWKS exposes the ES256 public key.
- [ ] The DCR probe returns 201 and deletes its temporary client with 204.
- [ ] Login and consent work in a fresh browser session.
- [ ] The callback reaches the client and `/token` returns successfully.
- [ ] The MCP endpoint rejects missing, malformed, expired, wrong-audience,
      wrong-issuer, and wrong-scope tokens.
- [ ] Refresh tokens rotate and old tokens cannot be reused.

## Operations

- [ ] `npm run check` passes.
- [ ] Both Compose configurations validate.
- [ ] A database backup exists before deployment.
- [ ] The previous application image has an explicit rollback tag.
- [ ] Restore procedures preserve OAuth users, clients, grants, and signing
      keys, cookie keys, sessions, and token state together.
- [ ] Sanitized OAuth logs are monitored during the first real client flow.
