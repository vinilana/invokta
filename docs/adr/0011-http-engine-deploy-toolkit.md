# ADR 0011: HTTP engine deployment toolkit

- Status: Accepted
- Date: 2026-07-28

## Context

Engine authors need a repeatable, reviewable path from a stateless MCP HTTP
server to a container build context and a bounded deployment probe. This work is
not capability execution, client installation, or composition validation.

## Decision

`@invokta/deploy` is a standalone native ESM development application exposing
`invokta-deploy`. It owns the closed `invokta.deploy.json` manifest and three
operations:

- `init` scaffolds a user-owned HTTP composition root, fail-closed
  authentication hook, environment-file loader, and `.env.example`;
- `package` generates a deterministic `Dockerfile`, `.dockerignore`, health
  check, and deployment guide; and
- `probe` performs one bounded request against an existing `/mcp` endpoint.

The toolkit has no runtime dependency and never imports an engine, calls
`engine.invoke`, executes a capability, starts an adapter, spawns a process,
runs a shell or package manager, or builds or deploys a container. `init` and
`package` perform no network operations; `probe` performs one request without
retry or redirect.

Generated code uses the public stateless `serveMcpHttp` API. Environment files
are loaded by generated, user-owned code with Node's `util.parseEnv`; the
framework publishes no environment runtime package. Container builds reinstall
from the user's lockfile and exclude every `.env*` file.

Scaffolded source is never overwritten. Marked deployment files may be
regenerated deterministically, while unmarked files remain user-owned. A 401
response with a Bearer challenge is accepted as liveness so probes do not need a
credential. TLS termination, forwarded public Host, allowlists, secrets, and
deployment topology remain operator responsibilities.

Toolkit errors, exit codes, manifest fields, and `INVOKTA_*` environment names
are deployment contracts; they do not extend `EngineError` or create another
capability execution path.

## Consequences

- Engine authors gain a reviewable conventional container build and CI probe.
- Generated files and environment names are compatibility surfaces.
- Secret hygiene and overwrite markers are release requirements.
- Provider-specific manifests and executing deployments remain outside scope.
