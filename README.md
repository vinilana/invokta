# Invokta

**Build software for the agents your users already use.**

Your customers and teams should not have to adopt another AI agent to use a
valuable product capability. They should be able to invoke it from an
MCP-compatible agent, application, CLI, or automation already in their workflow.

Invokta is the TypeScript framework for building **Action Engines**: versioned,
headless capabilities that remain independent of one agent harness. Headless
means the capability can be called without forcing the user through your UI or
into a proprietary agent.

Define the domain contract, access rule, tools, and validation once. Publish the
same implementation through application code, the CLI, MCP stdio, or stateless
MCP Streamable HTTP. Your product continues to own the action while users keep
the agent and interface they prefer.

For example, a calendar API can create an event. An Appointment Scheduling
Engine can expose `appointments.schedule`, check authorization and clinic rules,
revalidate the selected slot, write through the authorized calendar connector,
and return either a confirmation or a stable conflict.

The same boundary makes an internal software factory harness-agnostic. A team can
move between agent clients without copying prompts, integrations, permissions,
validation, and error handling into every harness.

## Run your first Action Engine

Standalone engines require Node.js 22.20.0 or later. The creator supports npm,
pnpm, and Yarn; this example uses npm.

```sh
npm create invokta-engine@latest my-engine -- --profile complete --yes
cd my-engine
npm run check
npm run direct -- Ada
```

The final command invokes the generated capability through `engine.invoke` and
prints:

```json
{"message":"Welcome, Ada!"}
```

Open the generated project and you will find the capability contract, its test,
the shared engine, and the selected entry points. Start the interactive
inspector in a separate terminal:

```sh
npm run devtools
# Open the URL printed by the command. Press Ctrl+C to stop.
```

If the profile includes MCP stdio, installation in detected agent clients is
optional:

```sh
npm run mcp:install
# Later:
npm run mcp:uninstall
```

Continue with the [getting-started guide](./docs/getting-started.md), inspect the
[`hello-engine`](./examples/hello-engine/), or browse
[use cases by company area](./apps/docs/src/content/docs/use-cases/index.mdx).

## One capability, every published entry point

Invokta starts with a domain action such as
`engineering.prepare-implementation`, not with a transport or provider API.

```text
Cursor ───────┐
Claude Code ──┤
Codex ────────┤
CLI ──────────┼──> engineering.prepare-implementation
Application ──┘                  |
                                  ├── ticket intent
                                  ├── repository context
                                  ├── architecture decisions
                                  ├── design
                                  ├── engineering rules
                                  └── implementation-ready brief
```

The consumers choose when to invoke the capability. The Action Engine owns how
the brief is prepared and validates the request and result through the same
execution pipeline every time.

![Claude Code, Codex, Hermes, and the CLI invoke one Action Engine that owns its providers, scripts, data, templates, permissions, contracts, and rules](./apps/docs/public/images/how-an-action-engine-works.svg)

This boundary gives the action:

- runtime-validated input and output contracts;
- one access rule and one structured failure model;
- one implementation reused by every published adapter;
- tests that do not require a complete agent session; and
- independent ownership and versioning as its internals evolve.

CLI and MCP adapters always reach capability execution through `engine.invoke`.
Business rules do not move into transport handlers.

## From MCP access to an owned product capability

MCP gives compatible agents a standard way to discover and call tools. Invokta
publishes each capability as an MCP tool while keeping the domain behavior in an
Action Engine that can also serve application code and the CLI.

| Building block | What it owns |
| --- | --- |
| Prompt or rule | Instructions and constraints for a model or agent |
| Skill | Guidance that teaches an agent when and how to perform work or invoke an action |
| MCP | A protocol for connecting AI applications to tools and data |
| Loop or graph | The order of steps, branches, retries, and stopping decisions |
| Action Engine | The versioned implementation and runtime contract of one domain outcome |

A skill may teach an agent when to call `support.classify-ticket`. MCP carries
the call, and a loop may decide what happens next. The Action Engine validates
the ticket, enforces access, invokes the classifier, validates the result, and
returns the same public shape to every consumer.

The full [Action Engines community definition](./docs/action-engines.md) is
framework-neutral and explains the category independently of Invokta.

## What an Action Engine can own

An engine can combine prompts, models, provider APIs, local scripts, templates,
data, permissions, and domain rules behind a small set of capabilities.

| Example engine | Example capabilities | What the caller receives |
| --- | --- | --- |
| Product Analytics Engine | `analytics.explain-funnel-change`, `analytics.prepare-account-summary` | A tenant-scoped explanation or account summary with supporting evidence |
| Video Production Engine | `video.transcribe-source`, `video.plan-edit`, `video.apply-edit` | A transcript, edit plan, and rendered video with evidence |
| Social Carousel Engine | `carousel.prepare-series`, `carousel.render-series`, `carousel.assess-readiness` | An ordered carousel that is ready to publish or has explicit blockers |
| Commercial Proposal Engine | `sales.prepare-proposal`, `sales.render-proposal`, `sales.assess-proposal-readiness` | A customer-specific proposal and a readiness decision |
| Appointment Scheduling Engine | `appointments.list-valid-slots`, `appointments.schedule`, `appointments.reschedule` | Valid options and a confirmed calendar write or stable conflict |
| Recruiting and Selection Engine | `recruiting.screen-candidate`, `recruiting.record-screening`, `recruiting.notify-review` | An evidence-backed screening record and a human-review notification |

These are illustrative domain boundaries, not provider integrations bundled
into the framework. Your engine owns its providers and outcome quality. See the
[complete use-case catalog](./apps/docs/src/content/docs/use-cases/index.mdx) for
examples across software products, engineering, content, product, marketing,
sales, healthcare, recruiting, support, and operations.

## What Invokta owns and what your engine owns

| Invokta provides | Your Action Engine provides |
| --- | --- |
| Capability and engine contracts | Domain-oriented capability IDs and schemas |
| Runtime input and output validation | Prompts, models, tools, scripts, and templates |
| Access enforcement and structured errors | Authentication and domain authorization integrations |
| Cancellation and minimal invocation events | Provider clients, data stores, and outbound connectors |
| Direct, CLI, MCP stdio, and stateless MCP HTTP entry points | Evaluations, metrics, and outcome-quality rules |
| Composition checks, devtools, installation, and deployment helpers | Deployment configuration and dependency lifecycle |

Invokta is deliberately not an identity provider, model router, agent harness,
workflow engine, provider catalog, or production observability platform. Those
boundaries remain explicit so an engine can change its implementation without
turning the framework into a service container.

<details>
<summary><strong>Packages and development tools</strong></summary>

- `@invokta/core` defines capabilities, typed connector factories, engines,
  validation, access, cancellation, errors, and events.
- `@invokta/cli` provides `list`, `describe`, and `run` through
  `engine.invoke`.
- `@invokta/mcp` publishes capabilities as tools over stdio and secure,
  stateless Streamable HTTP.
- `@invokta/tooling` validates composed capabilities and final MCP tool names.
- `@invokta/devtools` provides an engine inspector plus MCP and CLI
  workbenches.
- `@invokta/installer` installs and manages local or remote Action Engines in
  supported MCP clients.
- `@invokta/deploy` scaffolds and packages HTTP engines and probes deployed
  endpoints.
- `create-invokta-engine`, `create-invokta-capability`, and
  `create-invokta-capability-library` generate standalone, project-owned
  starters.

</details>

## Choose the smallest starter profile

| Profile | Generated execution channels | Choose it when |
| --- | --- | --- |
| `complete` | Direct, CLI, MCP stdio, MCP HTTP | You want the reference project or expect to publish every channel |
| `cli` | Direct and CLI | People or local automation will run commands |
| `mcp-stdio` | Direct and MCP stdio | Local agent clients will start the engine as a child process |
| `mcp-http` | Direct and MCP HTTP | Remote consumers need a shared, authenticated endpoint |

The generated README maps the project and provides a test-first checklist for
replacing the welcome capability. Generated projects also include `AGENTS.md`
and a development skill for compatible coding agents.

Use an official or public GitHub example as the starter:

```sh
npm create invokta-engine@latest my-engine -- --example hello-engine --yes
```

Generate selected capabilities from a bounded local OpenAPI 3.1.x contract:

```sh
npm create invokta-engine@latest my-engine -- --openapi ./openapi.yaml --yes
```

Read the complete
[`create-invokta-engine` reference](./packages/create-invokta-engine/README.md)
for profile contents, automation flags, GitHub imports, and OpenAPI limits.

## Learn from working examples

- [`hello-engine`](./examples/hello-engine/) is the shortest complete path.
- [`support-engine`](./examples/support-engine/) demonstrates dependency
  injection, authorization, safe errors, and all four execution channels.
- [`crawl-engine`](./examples/crawl-engine/) puts Firecrawl behind an
  engine-owned `WebCrawler` port.
- [`composed-engine`](./examples/composed-engine/) combines local, atomic, and
  library capabilities under deliberate effective IDs.
- [`spec-engine`](./examples/spec-engine/) keeps a spec-driven process and its
  stage rules inside the domain.
- [`review-engine`](./examples/review-engine/) provides a fail-closed completion
  review and adversarial gate.
- [`agent-session-engine`](./examples/agent-session-engine/) stores portable
  checkpoints across Cursor, Antigravity, Claude Code, and Codex.
- [`auth-self-hosted-oauth-engine`](./examples/auth-self-hosted-oauth-engine/)
  demonstrates a production-oriented OAuth boundary outside the framework
  runtime.

The [examples catalog](./apps/docs/src/content/docs/examples/index.mdx) covers
authentication, observability, image generation, Obsidian context, agent
routing, community capability packages, and MCP consumers.

## Create reusable capability packages

When an Action Engine is not the owning project, generate a standalone atomic
capability or a related capability library:

```sh
npm create invokta-capability@latest my-capability
npm create invokta-capability-library@latest my-library
```

## Contribute to Invokta

This repository uses Node.js 24.20.0 and Yarn 1.22.22.

```sh
corepack enable
yarn install --frozen-lockfile --non-interactive
yarn run check
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before editing. It covers repository
layout, branch preparation, RED/GREEN/REFACTOR, contract and ADR review,
validation, agent-team coordination, commits, and pull-request evidence.

## Documentation

- [Getting started](./docs/getting-started.md)
- [Documentation index](./docs/README.md)
- [Architecture and contracts](./docs/architecture.md)
- [Scope and limits](./docs/scope-and-limits.md)
- [Architecture decisions](./docs/adr/README.md)
- [Changelog](./CHANGELOG.md)

Invokta is available under the [MIT License](./LICENSE).
