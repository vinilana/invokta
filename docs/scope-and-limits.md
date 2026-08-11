# Scope and limits

## Public packages

**AE-SCOPE-01 — Ten packages with isolated roles.** Invokta publishes:

| Package | Responsibility |
| --- | --- |
| `@invokta/core` | Capability contracts, composition, execution, errors, and events |
| `@invokta/cli` | `list`, `describe`, and `run` over `engine.invoke` |
| `@invokta/mcp` | MCP server adapters and an isolated plain-type client facade over stdio and stateless Streamable HTTP |
| `@invokta/tooling` | Development-time validation of capability composition |
| `@invokta/installer` | End-user configuration of supported local MCP clients |
| `@invokta/deploy` | Development-time HTTP engine scaffolding, packaging, health probing, and read-only OAuth discovery inspection |
| `@invokta/devtools` | Development-time engine dev server, doctor diagnostics, and installed MCP inspection and homologation |
| `create-invokta-engine` | Interactive or automated creation of one bounded standalone starter profile, or import of one public GitHub example tree |
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

An official example may demonstrate a complete host-owned integration without
making its identity provider, token issuer, persistence, account policy, or
deployment topology a framework runtime abstraction. Production MCP OAuth uses
this boundary: Invokta owns Resource Server conformance and client homologation,
while the example owns one replaceable Authorization Server implementation.

## Explicit limits

| Dimension | Limit |
| --- | --- |
| Framework runtime packages | 3: core, CLI, and MCP |
| Supporting packages | 7: tooling, installer, deploy, devtools, and three project creators |
| Official adapters | CLI and MCP |
| MCP transports | stdio and stateless Streamable HTTP |
| Core primitives | Capability, Engine, Context, and Principal |
| Required capability fields | 5 |
| Invocation pipeline stages | 6 |
| Invocation error codes | 7 |
| Cross-cutting hooks | 1: `onEvent` |
| Auth or PDP implementations | 0 |
| Containers or runtime plugin systems | 0 |
| Concurrent attached devtools targets | 1 |
| Concurrent attached devtools tool calls | 1, explicitly initiated |

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

**AE-LIMIT-06 — Installed MCP inspection.** Devtools may initialize, list tools
from, and manually call one explicitly configured stdio or Streamable HTTP MCP
target. For an interactive HTTP target it may complete one ephemeral OAuth
Authorization Code with PKCE flow through the isolated official SDK. It does
not discover or import installations, persist connections or credentials,
connect multiple targets, invoke automatically, retry a connected tool call,
evaluate, judge, certify, or gate a release. Workspace-only Doctor, principals,
watch, core events, and `engine.invoke` trace claims do not apply to an attached
external target.

## Evolution triggers

An extension requires evidence and an architectural decision. Examples include
authentication support after several engines repeat the same integration, a
PDP adapter after multiple engines repeat one provider mapping, lifecycle only
when dependency start and stop behavior repeats, and observability or evaluation
packages only when engine-local implementations converge.
