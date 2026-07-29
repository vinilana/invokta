# Changelog

All notable changes to Invokta are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added `create-invokta-engine`, a non-interactive standalone engine creator with
  deterministic, non-overwriting scaffolding and npm, pnpm, and Yarn installation.

## [0.1.0] - 2026-07-29

### Added

- Added the initial native ESM package set for Node.js 22.20.0 and later:
  `@invokta/core`, `@invokta/cli`, `@invokta/mcp`, `@invokta/tooling`,
  `@invokta/installer`, and `@invokta/deploy`.
- Added typed capability contracts, Standard Schema and Standard JSON Schema
  validation, explicit access rules, structured errors, cancellation, timeouts,
  minimal invocation events, and capability composition to `@invokta/core`.
- Added direct, CLI, MCP stdio, and stateless MCP Streamable HTTP execution over
  the same `engine.invoke` pipeline.
- Added the `invokta check-capabilities` development gate for deterministic
  capability composition validation.
- Added the read-only `invokta-installer` inventory for supported local MCP
  clients, including fail-closed target and path evidence.
- Added `invokta-deploy` commands for deterministic HTTP engine scaffolding,
  deployment package generation, and bounded endpoint probes.
- Added the public documentation site, architecture decisions, practical
  recipes, package references, and complete example engines for onboarding,
  support, provider integration, capability composition, development workflows,
  local context, and observability.

### Security

- Added fail-closed input, output, identity, access, schema, and cancellation
  boundaries with sanitized public errors and payload-free invocation events.
- Added strict MCP HTTP route, Host, Origin, content type, UTF-8, authentication,
  request-size, and disconnect handling before capability invocation.
- Added bounded MCP stdio reads and lifecycle cleanup that preserves protocol-only
  standard output and contains late write failures.
- Added clean-tarball verification, isolated consumer imports, executable smoke
  tests, dependency auditing, and pinned GitHub Actions dependencies.

### Known limitations

- `@invokta/installer` provides a read-only inventory in this release. Its
  executable does not modify MCP client configuration.
- Invokta does not provide an identity provider, model router, workflow engine,
  runtime plugin system, eval runner, or production observability platform.
- The deploy toolkit generates reviewable artifacts but does not build images or
  deploy them to a hosting provider.

[Unreleased]: https://github.com/vinilana/invokta/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vinilana/invokta/releases/tag/v0.1.0
