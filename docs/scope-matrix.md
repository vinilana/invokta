# Scope and maturity matrix

This guide makes ownership explicit. The normative limits remain in
[scope and limits](./scope-and-limits.md); this matrix helps decide whether work
belongs in Invokta, a custom engine, or a later evidence-driven package.

## Responsibility matrix

| Concern | Invokta | Custom engine or host | Not provided |
| --- | --- | --- | --- |
| Domain API | Define, compose, list, describe, and invoke capabilities | Name domain actions and own compatible contracts | Generic model-call API |
| Schemas | Accept Standard Schema and Standard JSON Schema; validate input and output | Choose a compatible schema library and domain constraints | A new schema language or universal converter |
| Dependencies | Accept factories and closures | Define ports and wire model, data, and tool connectors | Container, service locator, connector registry, or lifecycle framework |
| Direct execution | Run the common `engine.invoke` pipeline | Supply trusted principal, signal, and dependencies | Distributed executor or background jobs |
| CLI | `list`, `describe`, `run`, JSON I/O, and stable exit codes | Own the executable, local principal, and untrusted-input bounds | Login, actor flags, or plugin discovery |
| MCP | Map capabilities to tools over stdio and stateless HTTP | Own process composition and deployment | Resources, prompts, tasks, sessions, or resumption |
| HTTP authentication | Run a required hook, issue a configured 401 Bearer challenge, and publish configured resource metadata | Verify credentials and return a minimal Principal | Identity provider, login, token lifecycle, or universal token verifier |
| Authorization | Enforce each capability's `access` rule before `run` | Encode domain policy or call a PDP | Policy language, role model, PDP adapter, or relationship graph |
| HTTP security | Default to loopback; validate exact Host, Origin, route, media types, and body bounds | Configure TLS, proxy trust, allowlists, exposure, and secrets | API gateway, WAF, or certificate management |
| Errors | Seven `EngineError` codes and safe adapter mappings | Keep public messages and details safe | Stack or cause disclosure and automatic recovery policy |
| Cancellation | Propagate signals and optional capability timeout | Make downstream I/O observe signals | Scheduler or durable execution |
| Retry, fallback, cache, routing | No automatic behavior | Implement domain-specific policies behind a capability or port | Framework-wide retry, model router, or semantic cache |
| Observability | Minimal payload-free `onEvent` hook | Connect logging, metrics, tracing, and domain measurements | Observability platform or economics envelope |
| AI implementation | Keep implementation replaceable | Own prompts, models, retrieval, tools, evidence, and risk controls | Provider SDKs, prompt registry, RAG abstraction, or memory |
| Quality | Validate contracts and provide testable direct execution | Own fixtures, evals, regression suites, and human review | Eval runner, automated judge, or canary platform |
| Capability reuse | Eager explicit composition with deterministic collision detection | Choose imports, effective IDs, and trusted dependencies | Runtime plugin marketplace or remote discovery |
| Supporting tools | Engine and capability-package creators, composition checker, MCP client installer, deployment generator, and engine dev server with doctor diagnostics | Review generated files and own local, package, or deployment authority | Autonomous publishing, installation, or deployment service |

## Fixed limits

| Dimension | Limit |
| --- | --- |
| Framework runtime packages | 3 |
| Supporting packages | 7 |
| Official inbound adapters | 2: CLI and MCP |
| MCP transports | 2: stdio and stateless Streamable HTTP |
| Core primitives | 4: Capability, Engine, Context, Principal |
| Required capability fields | 5 |
| Runtime pipeline stages | 6 |
| Invocation error codes | 7 |
| Cross-cutting hooks | 1: `onEvent` |
| Authentication implementations | 0 |
| Directly supported policy engines | 0 |
| Dependency containers | 0 |
| Runtime plugin systems | 0 |

These limits prevent speculative growth; they are not permanent targets. A new
concept requires a real engine case, executable evidence, and an architectural
decision.

## Maturity levels

| Level | Observable state | Relationship to Invokta |
| --- | --- | --- |
| A — Experiment | A prompt or model call lives inside one feature without a stable reusable boundary | Useful for discovery, below the framework target |
| B — Contracted capability | Runtime-validated input and output, isolated handler, direct invocation, and basic tests | Directly supported by the core |
| C — Reusable Action Engine | A domain capability serves independent consumers or channels without duplicating its handler | Primary framework outcome |
| D — Production Action Engine | Authentication, authorization, evals, tracing, cost and timeout controls, incident handling, and risk-appropriate review | Invokta supplies boundaries and hooks; the engine and platform own the controls |
| E — Action Engine platform | Federated catalog, shared routing, context, policy, rollout, economics, and governance at scale | Outside framework scope |

Invokta does not automatically make an engine production-ready. Cost,
hallucination risk, evidence, safety, availability, privacy, and human review
remain domain and deployment responsibilities.

## Evidence required before expansion

Invokta evolves by extraction, not prediction. Evaluate an extension only after
observable repetition, for example:

| Candidate | Minimum evidence |
| --- | --- |
| Authentication package | Several engines repeat the same real identity integration |
| PDP adapter | Multiple engines repeat the same provider mapping |
| Lifecycle | Multiple dependencies repeatedly require coordinated start and stop |
| Concurrency control | An engine demonstrates saturation that its host cannot solve |
| Eval runner | Multiple domains share a dataset and execution format |
| Observability package | Minimal events prove insufficient across real engines |
| Model router | Multiple capabilities repeat a selection or fallback policy |
| Context compiler | Repeated context strategies cause measurable inconsistency |

Until that evidence exists, keep the behavior in the custom engine's composition
root or an injected service.

An official example is executable integration guidance, not evidence that every
dependency it contains belongs in a framework runtime package. See ADR 0024 for
the production MCP OAuth boundary.
