# Version 0.1 scope and maturity matrix

This guide makes ownership explicit. The normative limits remain in
[v0.1 scope and limits](./v0.1-scope.md); this matrix helps decide whether work
belongs in the framework, a custom engine, or a later evidence-driven package.

## Responsibility matrix

| Concern | Framework v0.1 | Custom engine or host | Not provided in v0.1 |
| --- | --- | --- | --- |
| Domain API | Define, register, list, describe, and invoke capabilities | Name domain operations and own compatible contracts | Generic model-call API |
| Schemas | Accept Standard Schema + Standard JSON Schema and validate input/output | Choose a compatible schema implementation and domain constraints | A new schema language or universal converter |
| Dependency injection | Accept factories and closures | Define ports and wire concrete model, data, and tool adapters | Container, service locator, port registry, lifecycle framework |
| Direct execution | `engine.invoke` with the common pipeline | Supply trusted principal, signal, and injected dependencies | Distributed executor or background jobs |
| CLI | `list`, `describe`, `run`, argument/stdin JSON, structured output and exit codes | Own the executable, local principal, process exit, and untrusted-input bounds | Login, actor/role flags, generators, plugin discovery |
| MCP | Map capabilities to tools over stdio and stateless Streamable HTTP | Own process/server composition and deployment | Resources, prompts, sampling, elicitation, tasks, stateful sessions, resumption |
| HTTP authentication | Run a required authentication hook, issue a 401 challenge, and publish configured Resource Server metadata | Verify credentials with the chosen identity system and map a minimal Principal | Authorization Server, login, token issue/refresh/storage, universal JWT/JWKS or introspection client |
| Authorization | Enforce every capability's `access` rule before `run` | Encode domain policy or call a PDP from the rule | Role model, policy language, PDP adapter, relationship graph |
| HTTP boundary security | Default to loopback; validate exact Host and supplied Origin | Configure trusted hosts/origins, proxy boundary, TLS, network exposure, and secrets | General API gateway, WAF, certificate management |
| Errors | Seven `EngineError` codes and safe adapter mappings | Keep public messages/details safe and define domain error factories when useful | Stack/cause disclosure, automatic recovery policy |
| Cancellation and timeout | Propagate signals; optional capability timeout; active HTTP disconnect cancellation | Make downstream I/O observe signals and set integration-specific bounds | Cross-request cancellation for stateless HTTP, scheduler, durable execution |
| Retry, fallback, cache, and routing | No automatic behavior | Implement and test inside a capability or injected service when the domain needs it | Framework-wide retry, model router, semantic cache |
| Observability | Minimal `onEvent` hook without payloads or credentials | Connect logs, metrics, tracing, and domain-specific measurements | OpenTelemetry package, economics envelope, incident platform |
| AI implementation | Keep implementation replaceable behind the capability | Own prompts, models, retrieval, data, tools, evidence, and model risk | Provider SDKs, prompt registry, RAG abstraction, context compiler, memory |
| Quality | Validate contracts and provide testable direct execution | Own fixtures, evals, regression suites, review gates, and human review | Eval runner, LLM-as-judge abstraction, canary platform |
| Packaging | Three ESM packages: core, CLI, MCP | Version and own each custom engine | Additional public framework packages in 0.1 |

## Fixed v0.1 limits

| Dimension | Limit |
| --- | --- |
| Public packages | 3 |
| Official adapters | 2: CLI and MCP |
| MCP transports | 2: stdio and stateless Streamable HTTP |
| Core primitives | 4: Capability, Engine, Context, Principal |
| Required capability fields | 5 |
| Runtime pipeline stages | 6 |
| Error codes | 7 |
| Cross-cutting hooks | 1: `onEvent` |
| Authentication implementations | 0 |
| Directly supported policy engines | 0 |
| Dependency containers | 0 |
| Plugin systems | 0 |

These are barriers against speculative growth, not permanent targets. A new
concept requires a real engine case, executable evidence, and an architectural
decision.

## Maturity levels

| Level | Observable state | Relationship to v0.1 |
| --- | --- | --- |
| A — Experiment | A prompt or model call lives inside one feature without a stable contract or reusable boundary | Below the framework's target; useful for discovery |
| B — Contracted capability | Runtime-validated input/output, isolated handler, direct invocation, and basic tests | Directly supported by the core |
| C — Reusable AI Engine | A meaningful domain capability is reused through direct, CLI, and MCP channels without duplicating its handler | Primary v0.1 outcome |
| D — Production AI Engine | Authentication, domain authorization, evals, tracing, cost/timeout controls, incident handling, and risk-appropriate review | v0.1 supplies only minimal hooks; the engine and its platform own the controls |
| E — AI Engine platform | Federated catalog, shared routing/context/policy, rollout, canary, economics, and governance at scale | Explicitly outside v0.1 |

The framework does not automatically make an engine production-ready. Cost,
hallucination risk, evidence, safety, availability, privacy, and human review
remain domain and deployment responsibilities.

## Evidence required before expansion

Version 0.1 evolves by extraction, not prediction. Evaluate an extension only
after observable repetition, for example:

| Candidate | Minimum evidence suggested by the v0.1 plan |
| --- | --- |
| Engine scaffold | Stable core API across two real engines |
| Testing helpers | Three engines repeat the same fakes or assertions |
| OAuth Resource Server package | Three engines repeat discovery, challenge, and token verification |
| PDP adapter | Two engines repeat the same provider mapping |
| Formal modules | Object spread no longer addresses real ownership or metadata |
| Lifecycle | Multiple dependencies repeatedly require coordinated start/stop |
| Concurrency control | An engine demonstrates saturation that its host cannot solve |
| Eval runner | Two domains share a dataset and execution format |
| OpenTelemetry package | Minimal events prove insufficient in more than one engine |
| Model router | Multiple capabilities repeat a selection or fallback policy |
| Context compiler | Repeated context strategies cause measurable inconsistency |

Until that evidence exists, keep the behavior in the custom engine's composition
root or injected service and preserve the small public kernel.
