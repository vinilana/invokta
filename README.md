# Invokta

The TypeScript framework for building **Action Engines**.

An [Action Engine](./docs/action-engines.md) packages reusable, AI-supported
domain actions behind stable contracts, independently of the agents,
applications, and interfaces that invoke them. Define a capability once with
Invokta, then invoke the same runtime through application code, the CLI, MCP
stdio, or stateless MCP Streamable HTTP.

Invokta keeps capability execution in a compact hexagonal kernel:

- `@invokta/core` defines capabilities, validates Standard Schema input and
  output, enforces access rules, propagates cancellation, and emits minimal
  invocation events;
- `@invokta/cli` provides `list`, `describe`, and `run` without bypassing
  `engine.invoke`;
- `@invokta/mcp` publishes capabilities as tools over stdio and secure
  stateless HTTP while keeping the official MCP SDK behind the adapter boundary;
- `@invokta/tooling` validates composed capabilities during development;
- `@invokta/installer` configures supported MCP clients on a user's machine;
- `@invokta/deploy` scaffolds and packages stateless HTTP engines and probes
  deployed endpoints.

Invokta does not provide identity, model routing, an agent harness, a
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
  consumes the support capability only through MCP stdio;
- [`crawl-engine`](./examples/crawl-engine/) for an outbound provider
  integration, crawling the web with Firecrawl behind a port, with target rules
  that run before authorization;
- [`cursor-agent-routing-engine`](./examples/cursor-agent-routing-engine/) for
  deterministic Cursor subagent and model selection by development use case;
- [`image-engine`](./examples/image-engine/) for outcome-based routing across
  GPT Image 2, Seedream 5.0, and Nano Banana 2 behind replaceable domain ports;
- [`obsidian-context-engine`](./examples/obsidian-context-engine/) for bounded,
  progressive knowledge-graph navigation from Obsidian frontmatter and
  wikilinks through direct, CLI, and MCP entrypoints;
- [`spec-engine`](./examples/spec-engine/) for a spec-driven development
  workflow whose ordering, state, and per-step authorization live in the domain
  rather than in a workflow engine;
- [`agent-session-engine`](./examples/agent-session-engine/) for durable task,
  phase, checkpoint, and handoff state plus CLI-backed hooks for Cursor,
  Antigravity, Claude Code, and Codex;
- [`review-engine`](./examples/review-engine/) for a fail-closed code review,
  acceptance-eval, and adversarial-review gate that tells an agent whether a
  task is ready to be declared complete.

## Documentation

Start with the framework-neutral [Action Engines community
definition](./docs/action-engines.md). The [documentation
index](./docs/README.md) links Invokta's normative architecture, scope,
acceptance criteria, ADRs, HTTP authentication guide, capability authorization
guide, and explicit scope matrix.

All public behavior is developed with runtime and type-level tests. Repository
changes follow RED, GREEN, REFACTOR and use one cohesive commit per deliverable.

## License

Invokta is available under the [MIT License](./LICENSE).
