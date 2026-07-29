# Cursor Agent Routing Engine

This example publishes `developer-work.route-cursor-task`, a deterministic
capability that selects a Cursor custom subagent and model for seven software
development use cases. The same route is available through direct invocation,
the CLI, MCP stdio, and authenticated stateless MCP HTTP.

The model catalog is a versioned snapshot dated **2026-07-28**. Model names and
availability change independently of this repository and can vary by plan,
region, organization allowlist, and Cursor release.

## Routing catalog

| Use case | Custom agent | Primary Cursor model | Fallback | Read-only |
| --- | --- | --- | --- | --- |
| `plan` | `planner` | Claude Opus 5 | GPT-5.6 Sol | yes |
| `review` | `reviewer` | Claude Fable 5 | Claude Opus 5 | yes |
| `complex-development` | `complex-builder` | Grok 4.5 | GPT-5.6 Sol | no |
| `debug` | `debugger` | GPT-5.6 Sol | Claude Fable 5 | no |
| `documentation` | `documenter` | Gemini 3.6 Flash | Composer 2.5 | no |
| `prototype-development` | `prototyper` | Composer 2.5 Fast | GPT-5.6 Luna | no |
| `simple-development` | `simple-builder` | GPT-5.6 Luna | Composer 2.5 Fast | no |

The choices use Cursor's current guidance and published evidence:

- [Cursor Router](https://cursor.com/blog/router) sends simple work to
  price-efficient models and long-horizon work to frontier reasoning models.
- [Grok 4.5](https://cursor.com/grok) is positioned for long-running agentic
  work, migrations, multi-service changes, and sustained tool use.
- [Composer 2.5](https://cursor.com/composer) is Cursor's price-efficient coding
  model for everyday planning, development, fast interaction, and high-volume
  work.
- [CursorBench](https://cursor.com/cursorbench) provides current comparative
  evidence for code editing, debugging, planning, review, and terminal work.
- Cursor's [model picker and CLI model list](https://cursor.com/docs/cli/reference/parameters)
  remain the authoritative source for the selectors enabled for an account.

These assignments are explicit example policy, not a claim that one model is
universally best. The dated catalog makes policy changes reviewable instead of
silently changing routing behavior.

## Architecture

```text
Cursor parent agent
       |
       | MCP tool call with one useCase
       v
engine.invoke("developer-work.route-cursor-task")
       |
       v
versioned domain routing table
       |
       +--> custom agent name and read-only boundary
       +--> primary model selector
       +--> fallback model selector
       +--> self-contained delegation instructions
```

The framework core does not contain a model router, harness, loop, or Cursor
dependency. The model-selection policy belongs to this custom engine, and every
adapter executes the capability through `engine.invoke`.

The engine does not switch Cursor's active model by itself. The supplied custom
subagent definitions pin the returned selector in their `model` frontmatter;
the supplied rule tells the parent agent to consult the engine and invoke the
returned subagent. Cursor still enforces account and organization availability.

## Build and verify

From the repository root:

```sh
yarn workspace @ai-engine/example-cursor-agent-routing build
yarn workspace @ai-engine/example-cursor-agent-routing test
```

Before using the templates, authenticate the Cursor CLI and inspect the models
available to the current account:

```sh
agent models
```

If a selector differs, update both `src/domain/routing.ts` and the matching file
under `cursor-config/agents/`. The configuration test prevents those two sources
from drifting.

## Direct and CLI invocation

```sh
node examples/cursor-agent-routing-engine/dist/direct.js debug

node examples/cursor-agent-routing-engine/dist/cli.js list
node examples/cursor-agent-routing-engine/dist/cli.js describe developer-work.route-cursor-task
node examples/cursor-agent-routing-engine/dist/cli.js run developer-work.route-cursor-task \
  --input '{"useCase":"complex-development"}'
```

An unsupported use case fails during input validation with `INPUT_INVALID`.
There is no external request, retry, mutable state, or unbounded work in the
capability.

## Install the Cursor project configuration

Cursor discovers project subagents only from `<workspace-root>/.cursor/agents/`.
To use this example from the repository root:

1. Build the example.
2. Copy the seven files from `cursor-config/agents/` into
   `.cursor/agents/` at the workspace root.
3. Copy `cursor-config/rules/model-routing.mdc` into `.cursor/rules/`.
4. Merge the `cursor-agent-routing` server from `cursor-config/mcp.json` into
   the workspace `.cursor/mcp.json`; preserve any existing MCP servers.
5. Reload Cursor and verify the tool with
   `agent mcp list-tools cursor-agent-routing`.

The rule classifies work into one of the seven use cases, calls
`developer-work.route-cursor-task`, and delegates to the custom agent named by
`agent.invocation`. Custom subagent configuration follows Cursor's
[Subagents documentation](https://cursor.com/docs/subagents). Cursor also
supports general model family names for subagents, but this example intentionally
pins a dated model to make routing reproducible.

## MCP stdio and HTTP

The project configuration starts the stdio adapter directly:

```sh
node examples/cursor-agent-routing-engine/dist/mcp-stdio.js
```

For an authenticated loopback HTTP demonstration:

```sh
CURSOR_ROUTING_ENGINE_BEARER_TOKEN=development-only-token \
  node examples/cursor-agent-routing-engine/dist/mcp-http.js
```

The literal bearer-token comparison is only a deterministic authentication-hook
example. It does not issue, rotate, persist, or validate production credentials.

## Updating the catalog

Treat a model refresh as a versioned contract change:

1. Run `agent models` for the target Cursor account and review Cursor's official
   model guidance and current benchmark evidence.
2. Update the dated routes and fallbacks in `src/domain/routing.ts`.
3. Update the matching `model:` values in `cursor-config/agents/`.
4. Change `catalogDate`, extend the routing tests, and rerun the full validation
   suite.

Do not silently map an unavailable selector to another model inside the engine.
The explicit fallback makes that operational decision visible to the parent
agent and the user.
