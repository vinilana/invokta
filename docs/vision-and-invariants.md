# Vision and invariants

## Definition

An **AI Engine** is a versioned software component that publishes reusable,
AI-supported domain capabilities through stable contracts. Models, prompts, data,
retrieval, and tools remain replaceable internal details.

An implementation is an AI Engine when it publishes at least one domain-oriented
operation, validates input and output, encapsulates the AI implementation, can be
reused through more than one channel, and has a clear unit of versioning and
ownership.

## Distinct responsibilities

- **AI Engine:** delivers reusable domain capabilities governed by contracts.
- **Harness:** manages an agent's messages, tools, memory, environment, and
  execution.
- **Loop:** decides the next step, repeats work, and stops when it reaches a goal.
- **Framework:** provides contracts, a runtime, and adapters; it is not a domain
  engine.

A product may combine these responsibilities, but the core MUST NOT couple them.
A model wrapper, prompt collection, multi-model gateway, server that merely
mirrors APIs, harness, or workflow engine is not an AI Engine by itself.

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

**AE-INV-04 — Reuse.** The same capability MUST be invocable directly, through
the CLI, and through MCP without duplicating the handler.

## Conceptual contracts

**AE-CAP-01 — Minimal capability.** Every capability MUST declare exactly five
required elements: `description`, `input`, `output`, `access`, and `run`. `title`,
`timeoutMs`, and `annotations` are optional. The ID is not part of the definition;
it is the key used in `createEngine`.

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
being returned.

**AE-ACCESS-01 — Explicit rule.** Every capability MUST declare `access` as
`public`, `authenticated`, or an asynchronous/synchronous function. `public`
accepts `principal = null`; `authenticated` requires a `Principal`; a function
permits access only when it returns `true`.

**AE-CTX-01 — Minimal context.** `ExecutionContext` MUST contain only `requestId`,
`source`, `principal`, `signal`, and `logger`. `source` is `direct`, `cli`,
`mcp-stdio`, or `mcp-http`. The context MUST NOT contain a service locator, port
registry, error factory, policy context, or mutable metadata bag.

**AE-PRINCIPAL-01 — Minimal identity.** `Principal` MUST contain `id` and MAY
contain read-only `attributes`. Roles, scopes, tenants, groups, and claims are not
standardized; when needed, they belong in `attributes`.

## Maturity

v0.1 addresses level B, a contracted capability, and level C, a reusable engine.
It provides minimal extension points for level D through pluggable authentication,
authorization, and events. It MUST NOT attempt to implement the federated
platform of level E.
