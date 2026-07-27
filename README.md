# AI Engine Framework

A small TypeScript framework for publishing AI-backed domain capabilities behind
stable contracts. Define a capability once, then invoke the same runtime through
application code, the CLI, MCP stdio, or stateless MCP Streamable HTTP.

Version 0.1 focuses on a compact hexagonal kernel:

- `@ai-engine/core` defines capabilities, validates Standard Schema input and
  output, enforces access rules, propagates cancellation, and emits minimal
  invocation events;
- `@ai-engine/cli` provides `list`, `describe`, and `run` without bypassing
  `engine.invoke`;
- `@ai-engine/mcp` publishes capabilities as tools over stdio and secure
  stateless HTTP while keeping the official MCP SDK behind the adapter boundary.

The framework does not provide identity, model routing, an agent harness, a
workflow engine, or a production observability platform. Custom engines inject
their own model, data, tool, authentication, and authorization integrations.

## Start here

Requirements: Node.js 22.20.0 or later and Yarn 1.22.22.

```sh
yarn install --frozen-lockfile
yarn run check
```

Then follow the [getting-started guide](./docs/getting-started.md) or inspect:

- [`hello-engine`](./examples/hello-engine/) for the shortest complete path;
- [`support-engine`](./examples/support-engine/) for dependency injection,
  domain authorization, safe errors, and all four execution channels;
- [`support-harness`](./examples/support-harness/) for a private harness that
  consumes the support capability only through MCP stdio.

## Documentation

The [documentation index](./docs/README.md) links the normative architecture,
scope, acceptance criteria, ADRs, HTTP authentication guide, capability
authorization guide, and explicit v0.1 scope matrix.

All public behavior is developed with runtime and type-level tests. Repository
changes follow RED, GREEN, REFACTOR and use one cohesive commit per deliverable.
