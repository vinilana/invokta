# Invokta

The TypeScript framework for building **Action Engines**.

An [Action Engine](./docs/action-engines.md) packages reusable, AI-supported
domain actions behind stable contracts, independently of the agents,
applications, and interfaces that invoke them. Define a capability once with
Invokta, then invoke the same runtime through application code, the CLI, MCP
stdio, or stateless MCP Streamable HTTP.

## Why Action Engines matter

> If your MCP tool or CLI command creates a specification, retrieves project
> context, guides a workflow, reviews code, or classifies a ticket, you are
> already building an Action Engine.

The result of that action is the durable asset. MCP, CLI, HTTP, and direct APIs
are delivery paths that let consumers reach it.

Many projects still begin with the delivery path. Each use case gets its own MCP
server, CLI parsing, schema conversion, authentication, error mapping,
cancellation, and logging. AI makes the first integration faster to build, while
long-term ownership still includes security, tests, protocol upgrades, and
keeping every interface consistent.

We keep seeing the same pattern: the first integration ships quickly, then a
second agent or interface exposes decisions shaped around the original
transport. Teams revisit schemas, authorization, errors, and business rules, and
sometimes rebuild the feature around a stable domain boundary.

An Action Engine gives that behavior its own boundary. For example,
`support.classify-ticket` can validate the same request, enforce the same access
rule, and return the same result whether it is called by an agent, a workflow,
application code, the CLI, or MCP. The model, prompt, retrieval strategy, and
provider can change inside the engine without forcing every consumer to change.

This boundary makes a domain action:

- reusable across consumers and execution channels;
- testable without running a complete agent or workflow;
- governed by explicit input, output, access, and failure contracts; and
- independently owned and versioned as its implementation evolves.

## Where Action Engines fit

Prompts, rules, and skills guide behavior, while loops and graphs coordinate it.
Action Engines give the domain behavior they invoke a stable execution boundary.

```text
agent, application, or automation
  guided by prompts, rules, and skills
  coordinated by loops and graphs
  invokes Action Engines
    which use models, prompts, data, tools, and services internally
```

| Concept | What it owns | Relationship to an Action Engine |
| --- | --- | --- |
| Prompt | Instructions and context for a model call | May help a consumer choose an action or implement part of a capability inside the engine |
| Rule | A constraint, permission, or deterministic decision | May govern when an action is selected or be enforced by the engine as access or domain policy |
| Skill | Packaged instructions, knowledge, and resources for an agent | Teaches an agent when and how to invoke an action without owning the action's runtime contract |
| Loop | The decision to continue, stop, or choose the next action | Invokes Action Engines while retaining control of iteration and stopping conditions |
| Graph | Nodes, dependencies, branches, and execution order | Uses Action Engines as contracted nodes without absorbing their domain implementation |
| Action Engine | A reusable domain outcome with runtime-validated contracts, access, execution, and stable failures | Provides the callable boundary shared by agents, applications, loops, graphs, and interfaces |

The same system can use all six concepts. The separation lets orchestration and
agent behavior change without duplicating the domain action, while the engine
can change its AI implementation without rewriting its consumers. See the
[framework-neutral category definition](./docs/action-engines.md) for the full
conceptual model.

## What Invokta provides

Invokta makes the action contract the starting point and provides the reusable
framework layer around it. Define the capability once with its input, output,
access rule, and execution behavior; Invokta runs it through the same validated
pipeline from application code, the CLI, or MCP.

Use that boundary to build engines for spec-driven development (creating and
reviewing specifications), context retrieval, workflow guidance, code review,
image production, support operations, or another domain outcome. Your team owns
the domain contract, business rules, prompts, model and data integrations,
evaluations, and outcome quality. Invokta supplies the shared runtime mechanics
and delivery adapters:

- `@invokta/core` defines capabilities, validates Standard Schema input and
  output, enforces access rules, propagates cancellation, and emits minimal
  invocation events;
- `@invokta/cli` provides `list`, `describe`, and `run` without bypassing
  `engine.invoke`;
- `@invokta/mcp` publishes capabilities as tools over stdio and secure
  stateless HTTP while keeping the official MCP SDK behind the adapter boundary;
- `@invokta/tooling` validates composed capabilities during development;
- `@invokta/installer` currently provides a read-only inventory of supported
  local MCP client targets without changing their configuration;
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
  task is ready to be declared complete;
- [`observability-engine`](./examples/observability-engine/) for bounded incident
  context normalized from Sentry, Datadog, and New Relic;
- [`community-capabilities`](./examples/community-capabilities/) for atomic and
  library capability publication forms; and
- [`composed-engine`](./examples/composed-engine/) for combining local, atomic,
  and library capabilities under deliberate effective IDs.

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
