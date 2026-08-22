# Vision and invariants

## Definition

An **Action Engine** is a versioned software component that publishes reusable,
AI-supported domain capabilities through stable contracts. Models, prompts, data,
retrieval, and tools remain replaceable internal details.

This is Invokta's normative specialization of the framework-neutral
[Action Engines community definition](./action-engines.md). Invokta is the
framework; Action Engine is the architectural category.

In Invokta, a capability is the implementation unit behind a published domain
action. The capability key is the action's public ID.

An implementation is an Action Engine when it publishes at least one
domain-oriented operation, validates input and output, encapsulates the AI
implementation, can be reused through more than one channel, and has a clear
unit of versioning and ownership.

## Distinct responsibilities

- **Action Engine:** delivers reusable domain capabilities governed by contracts.
- **Prompt:** gives a model instructions and context for one part of a task or
  capability implementation.
- **Rule:** expresses a constraint, permission, or deterministic decision.
- **Skill:** packages guidance, knowledge, and resources that help an agent use
  an action correctly.
- **Harness:** manages an agent's messages, tools, memory, environment, and
  execution.
- **Loop:** decides the next step, repeats work, and stops when it reaches a goal.
- **Graph:** owns nodes, dependencies, branches, and execution order.
- **Port:** gives capability code an engine-owned, provider-neutral interface to
  a dependency.
- **Outbound connector:** implements one or more ports for an external provider,
  technology, or data source; it is not independently invocable.
- **Invokta:** provides contracts, a runtime, and inbound adapters; it is not a
  domain engine.

A product may combine these responsibilities, but Invokta's core MUST NOT couple
them. Prompts and skills may guide an invocation, rules may constrain it, ports
may define its dependencies, outbound connectors may implement external ones,
and loops or graphs may coordinate it.
The Action Engine remains the independently owned boundary for the requested
domain outcome. CLI, MCP, HTTP, and direct APIs are inbound delivery paths to
that boundary and MUST NOT become separate implementations of the domain action.

A model wrapper, prompt collection, multi-model gateway, server that merely
mirrors APIs, harness, or workflow engine is not an Action Engine by itself.

## Invariants

**AE-INV-01 — Capability first.** The public interface MUST represent a domain
action, such as `support.classify-ticket`, and MUST NOT represent infrastructure,
such as `llm.complete`.

**AE-INV-02 — Stable contract.** Input and output MUST be validated at runtime and
described by schemas. The consumer MUST NOT need to know about the prompt, model,
retrieval, or fallback.

**AE-INV-03 — Replaceable implementation.** The model, provider, prompt, database,
vector store, and tool MAY change without changing the public contract in a way
that breaks compatibility.

**AE-INV-04 — Reuse.** The same capability MUST be invocable directly and
through every adapter an engine publishes without duplicating the handler. The
`complete` reference and release conformance profile MUST demonstrate direct,
CLI, MCP stdio, and MCP HTTP reuse together. A focused generated starter MAY
omit adapters, but MUST NOT claim that an omitted channel is supported.

## Conceptual contracts

**AE-CAP-01 — Minimal capability.** Every capability MUST declare exactly five
required elements: `description`, `input`, `output`, `access`, and `run`. `title`,
`timeoutMs`, and `annotations` are optional. The ID is not part of the definition;
it is the key used in `createEngine`. When provided, `timeoutMs` MUST be a
positive integer no greater than `2_147_483_647`.

**AE-ENG-01 — Minimal engine.** Every engine MUST declare `name`, `version`, and
`capabilities`. `logger` and `onEvent` are optional. The resulting public API
provides `invoke`, `list`, and `describe`.

**AE-SCHEMA-01 — Existing standards.** `input` and `output` MUST be simultaneously
compatible with Standard Schema v1, for validation and inference, and Standard
JSON Schema v1, for description in adapters. The framework MUST NOT invent
another schema abstraction or depend on Zod in the core.

**AE-SCHEMA-02 — JSON object.** Input and output MUST be JSON-serializable and
have an object root schema. Both are required. Input is validated and transformed
before authorization and execution; output is validated and transformed before
being returned. The transformed values MUST remain inside the lossless JSON data
model defined in ADR 0002. After input validation, the runtime MUST capture a
deep request-owned snapshot. The access rule receives a separate deep snapshot,
while `run` receives the unmodified execution snapshot; mutations by the caller
or access rule MUST NOT cross these boundaries.

**AE-ACCESS-01 — Explicit rule.** Every capability MUST declare `access` as
`public`, `authenticated`, or an asynchronous/synchronous function. `public`
accepts `principal = null`; `authenticated` requires a `Principal`; a function
receives `{ principal, input, context, capabilityId }` and permits access only
when it returns `true`.

**AE-CTX-01 — Minimal context.** `ExecutionContext` MUST contain only `requestId`,
`source`, `principal`, `signal`, and `logger`. `source` is `direct`, `cli`,
`mcp-stdio`, or `mcp-http`. The context MUST NOT contain a service locator, port
registry, error factory, policy context, or mutable metadata bag.

**AE-PRINCIPAL-01 — Minimal identity.** `Principal` MUST be a structured-cloneable
record with a non-empty string `id` and MAY contain `attributes` as a
structured-cloneable record. Roles, scopes, tenants, groups, and claims are not
standardized; when needed, they belong in `attributes`. The runtime MUST capture
the request identity before asynchronous pipeline work and provide independent
deep snapshots to authorization and execution. A malformed or uncloneable
non-null identity fails as `UNAUTHENTICATED` before `access` or `run`.

## Maturity

Invokta addresses level B, a contracted capability, and level C, a reusable
engine. It provides minimal extension points for level D through pluggable
authentication, authorization, and events. It MUST NOT attempt to implement the
federated platform of level E.
