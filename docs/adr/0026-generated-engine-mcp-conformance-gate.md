# ADR 0026: Generated engine MCP conformance gate

- Status: Accepted
- Date: 2026-08-11

## Context

Invokta derives portable MCP tool names at the protocol boundary, while domain
capability IDs remain free to use names such as `tasks.create`. A catalog can
still be invalid when two distinct IDs derive the same public name, for example
`support.echo` and `support_echo`.

The MCP adapters already reject that ambiguity before connecting or listening,
but generated engine checks previously stopped after typechecking, tests, and a
build. Authors could therefore discover a catalog failure only when starting,
installing, or deploying the adapter.

## Decision

`@invokta/mcp` exposes `validateMcpToolCatalog(engine)`, the same catalog
construction boundary used by MCP stdio and HTTP. A collision throws the
structured `McpToolNameCollisionError`, which remains a `TypeError` and carries
only its stable code, the two capability IDs, and the derived public tool name.

`@invokta/tooling` exposes the build-time command:

```text
invokta check-mcp <esm-module> [--export <name>]
```

The command imports a trusted built ESM module, selects `engine` by default,
and validates its actual MCP catalog without starting an adapter or invoking a
capability. Success is silent. A catalog collision exits `1` with deterministic,
payload-free diagnostics; usage, load, export, or engine-shape failures exit
`2`.

Every closed `create-invokta-engine` profile that contains MCP stdio or HTTP
adds `@invokta/tooling`, a `check:mcp` script, and the same preflight at the end
of its canonical `check` after the engine build. The CLI-only profile does not
receive MCP tooling. Imported GitHub examples remain owned by their template
and are not rewritten beyond the existing package-name rule.

The gate validates the published tool catalog rather than imposing the MCP
name grammar on domain IDs. Dotted IDs are valid when their derived aliases are
portable and unique.

## Consequences

- A newly generated MCP engine catches ambiguous public tool names during its
  normal local and CI check, before installation or deployment.
- The preflight and both adapters use one catalog implementation, so the linter
  cannot drift into an adapter-specific naming policy.
- Validation imports trusted application code but performs no handler
  invocation, network request, authentication, or transport startup.
- Existing generated projects can add the tooling command manually; generators
  do not mutate projects after creation.
