# Scope and limits

## Public packages

**AE-SCOPE-01 — Nine packages with isolated roles.** Invokta publishes:

| Package | Responsibility |
| --- | --- |
| `@invokta/core` | Capability contracts, composition, execution, errors, and events |
| `@invokta/cli` | `list`, `describe`, and `run` over `engine.invoke` |
| `@invokta/mcp` | MCP tools over stdio and stateless Streamable HTTP |
| `@invokta/tooling` | Development-time validation of capability composition |
| `@invokta/installer` | End-user configuration of supported local MCP clients |
| `@invokta/deploy` | Development-time HTTP engine scaffolding, packaging, and probing |
| `create-invokta-engine` | Interactive or automated creation of one bounded standalone starter profile |
| `create-invokta-capability` | Creation of a standalone atomic capability package |
| `create-invokta-capability-library` | Creation of a standalone capability-library package |

All packages are native ESM. The core has no transport dependency. Runtime
adapters depend only on the core's public API, and supporting applications do
not create another capability execution path.

## Ownership

**AE-SCOPE-02 — Framework.** Invokta provides typed capability definitions,
runtime validation, eager composition, direct execution, minimal context,
access enforcement, events, CLI and MCP adapters, and narrowly scoped supporting
tools.

**AE-SCOPE-03 — Custom engine.** Capabilities, prompts, models, data and tool
integrations, business rules, domain authorization, evals, metrics, and
dependency lifecycle belong to the engine built by the user.

**AE-SCOPE-04 — Evolution by extraction.** New abstractions require repeated
evidence across real engines. They are not added because they may eventually be
useful.

## Explicit limits

| Dimension | Limit |
| --- | --- |
| Framework runtime packages | 3: core, CLI, and MCP |
| Supporting packages | 6: tooling, installer, deploy, and three project creators |
| Official adapters | CLI and MCP |
| MCP transports | stdio and stateless Streamable HTTP |
| Core primitives | Capability, Engine, Context, and Principal |
| Required capability fields | 5 |
| Invocation pipeline stages | 6 |
| Invocation error codes | 7 |
| Cross-cutting hooks | 1: `onEvent` |
| Auth or PDP implementations | 0 |
| Containers or runtime plugin systems | 0 |

**AE-LIMIT-01 — Runtime.** Invokta does not provide universal lifecycle,
queues, concurrency control, automatic retries, distributed execution, jobs,
scheduling, arbitrary streaming, or a progress API.

**AE-LIMIT-02 — Architecture.** Invokta does not provide a dependency
container, service locator, runtime plugin discovery, remote registry, or
mutable module lifecycle. Capability composition is explicit, eager, and based
on values imported by the application.

**AE-LIMIT-03 — AI and quality.** Invokta does not provide a model router,
context compiler, memory, RAG abstraction, prompt registry, official provider
adapters, semantic cache, economics engine, eval runner, automated judge,
release gate, or canary platform.

**AE-LIMIT-04 — Security.** Invokta does not provide an identity provider,
token issuer, universal JWT/JWKS or introspection client, DPoP, mTLS, policy
language, relationship graph, PDP adapter, or session binding.

**AE-LIMIT-05 — MCP.** Invokta does not provide MCP resources, prompts,
sampling, elicitation, tasks, stateful sessions, resumption, or server-to-client
requests.

## Evolution triggers

An extension requires evidence and an architectural decision. Examples include
authentication support after several engines repeat the same integration, a
PDP adapter after multiple engines repeat one provider mapping, lifecycle only
when dependency start and stop behavior repeats, and observability or evaluation
packages only when engine-local implementations converge.
