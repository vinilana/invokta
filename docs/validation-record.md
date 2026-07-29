# Validation record

- Last reviewed: 2026-07-29
- Public API changes: none

## Reuse evidence

The repository exercises Action Engines across independent domains and
execution channels:

| Evidence | Domain behavior | Channels or consumers |
| --- | --- | --- |
| `examples/hello-engine` | Minimal onboarding action | Direct, CLI, MCP stdio, MCP HTTP |
| `examples/support-engine` | Ticket classification with domain authorization | Direct, CLI, MCP stdio, MCP HTTP, independent MCP harness |
| `examples/crawl-engine` | Outbound web provider behind a port | Direct, CLI, MCP stdio, MCP HTTP |
| `examples/image-engine` | Replaceable multi-provider image routing | Direct, CLI, MCP stdio, MCP HTTP |
| `examples/composed-engine` | Local, atomic, and library capability composition | Direct, CLI, MCP stdio, MCP HTTP, tooling build gate |
| `examples/agent-session-engine` | Durable task and handoff state | Direct, CLI, MCP stdio, MCP HTTP, harness hooks |

The support harness uses the official MCP client and imports no Invokta runtime
package. Tool discovery and invocation therefore demonstrate that an independent
consumer can use the protocol surface without coupling to engine code.

## Boundaries exercised

- Input and output use the same Standard Schema and Standard JSON Schema
  declarations across direct, CLI, and MCP execution.
- All adapters converge on `engine.invoke`; none duplicates validation,
  authorization, execution, or output validation.
- MCP stdio keeps stdout protocol-only and propagates cancellation within one
  connection lifetime.
- MCP HTTP authenticates at the request boundary, authorizes in the core, and
  creates no cross-request session state.
- Capability composition preserves explicit imports and fails deterministically
  on effective-ID collisions.
- The installer and deploy packages remain outside the capability call graph and
  exercise only their documented local configuration and generation authority.

## Ownership conclusions

Invokta supplies stable contracts, a small execution kernel, adapters, explicit
composition, and bounded supporting tools. Custom engines continue to own model
and data providers, prompts, domain policies, evaluation, observability,
dependency lifecycle, and production risk controls.

The examples validate framework reuse; they do not claim provider quality,
production identity assurance, evaluation coverage, cost control, incident
readiness, privacy compliance, or safety for a particular domain. Those claims
require evidence from the engine and its deployment environment.
