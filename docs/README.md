# AI Engine Framework v0.1

This documentation is the normative source for implementing version 0.1.0. The
framework allows a domain capability to be defined once and executed through a
direct call, the CLI, MCP stdio, and stateless MCP Streamable HTTP.

## Reading order

1. [Vision and invariants](./vision-and-invariants.md)
2. [Architecture and contracts](./architecture.md)
3. [v0.1 scope and limits](./v0.1-scope.md)
4. [Implementation plan and acceptance criteria](./implementation-plan-and-acceptance-criteria.md)
5. [Architecture decision records](./adr/README.md)
6. [M6 validation record](./validation-record.md)

## Guides and examples

These guides apply the normative contracts above. When a guide or example
conflicts with a contract or ADR, the normative source takes precedence.

- [Getting started: direct, CLI, MCP stdio, and MCP HTTP](./getting-started.md)
- [Integrating an identity provider at the HTTP boundary](./http-authentication.md)
- [Integrating a PDP through a capability access rule](./capability-authorization.md)
- [Authoring and composing community capabilities](./capability-composition.md)
- [Version 0.1 scope and maturity matrix](./scope-matrix.md)
- [`hello-engine`: minimal onboarding example](../examples/hello-engine/)
- [`support-engine`: dependency injection and authorization example](../examples/support-engine/)
- [`support-harness`: private MCP consumer](../examples/support-harness/)
- [`crawl-engine`: outbound provider integration with Firecrawl](../examples/crawl-engine/)
- [`observability-engine`: Sentry, Datadog, and New Relic incident context](../examples/observability-engine/)
- [`obsidian-context-engine`: progressive Obsidian knowledge-graph navigation](../examples/obsidian-context-engine/)
- [`spec-engine`: spec-driven development workflow as domain rules](../examples/spec-engine/)
- [`review-engine`: fail-closed task completion review](../examples/review-engine/)
- [`agent-session-engine`: durable cross-harness sessions and CLI-backed hooks](../examples/agent-session-engine/)
- [`community-capabilities`: atomic and library capability publication fixture](../examples/community-capabilities/)
- [`composed-engine`: local, atomic, and library capability composition](../examples/composed-engine/)

## Normative language

The terms **MUST**, **MUST NOT**, **SHOULD**, **MAY**, and **OPTIONAL** indicate,
respectively, requirements, prohibitions, recommendations, and permitted
extensions. Requirements identified as `AE-<AREA>-NN` are tracked in the
acceptance matrix.

In the event of a conflict, the scope specification and the most recent ADRs take
precedence over examples. A change that expands the public API or the concepts in
v0.1 requires a real use case, a test, and an explicit architectural decision.

## Reference outcome

An engine must publish the same capability without duplicating business rules:

```text
my-engine list
my-engine describe support.classify-ticket
my-engine run support.classify-ticket --input '{"ticketId":"T-123"}'
my-engine-mcp --transport stdio
my-engine-mcp --transport http --port 3000
```
