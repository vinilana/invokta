# Invokta documentation

Invokta is a TypeScript framework for building agent-ready software without
coupling domain capabilities to one agent harness. Define a capability once and
execute the same implementation through a direct call, the CLI, MCP stdio, or
stateless MCP Streamable HTTP.

An Action Engine is the headless capability boundary behind those channels. A
customer can use an MCP-compatible agent, an internal team can change harnesses,
and an application can invoke the capability directly while the domain contract,
access rule, execution, and validation remain owned in one place.

The broader [Action Engines community definition](./action-engines.md) is
framework-neutral and intended for independent adoption. Invokta's normative
contracts below define one implementation of that concept.

## Choose your path

| Goal | Recommended path |
| --- | --- |
| Make product capabilities available to existing agents | [Action Engines](./action-engines.md) and [software product use cases](../apps/docs/src/content/docs/use-cases/index.mdx#software-products) |
| Create and run an Action Engine | [Getting started](./getting-started.md) |
| Choose a domain outcome | [Use cases by company area](../apps/docs/src/content/docs/use-cases/index.mdx) |
| Add a provider or data source | [Outbound connector recipe](../apps/docs/src/content/docs/recipes/external-provider.mdx) |
| Secure an MCP HTTP engine | [HTTP authentication](./http-authentication.md) |
| Install an engine in agent clients | [Installer reference](../apps/docs/src/content/docs/reference/installer.mdx) |
| Contribute to Invokta | [Contributor guide](../CONTRIBUTING.md) |
| Change a public contract | Follow the maintainer reading order below before editing |

## Framework maintainer reading order

1. [Action Engines community definition](./action-engines.md)
2. [Vision and invariants](./vision-and-invariants.md)
3. [Architecture and contracts](./architecture.md)
4. [Scope and limits](./scope-and-limits.md)
5. [Delivery workflow and acceptance criteria](./implementation-plan-and-acceptance-criteria.md)
6. [Architecture decision records](./adr/README.md)
7. [Validation record](./validation-record.md)

The [ADR index](./adr/README.md) is the canonical inventory of accepted
decisions. The [changelog](../CHANGELOG.md) records release-level delivery and
known limitations; this index does not duplicate either chronology.

## Design notes

Proposals under review. They are not delivered behavior and do not override a
contract or ADR; each one records the boundary it would need before it becomes
an architecture decision.

- [Connector brokers and request-time credentials](./connector-brokers.md) —
  integrating Vercel Connect or another connector broker without extending the
  core
- [Invokta Gateway: MVP plan](./invokta-gateway.md) — a web application that
  builds and publishes Action Engines from configured REST and GraphQL
  connectors, with Better Auth and Vercel Connect, outside the framework
  packages

## Guides and examples

These guides apply the normative contracts above. When a guide or example
conflicts with a contract or ADR, the normative source takes precedence.

- [Getting started: direct, CLI, MCP stdio, and MCP HTTP](./getting-started.md)
- [File naming and project structure for custom engines](../apps/docs/src/content/docs/guides/file-naming.mdx)
- [Integrating an identity provider at the HTTP boundary](./http-authentication.md)
- [Self-hosted OAuth recipe](../apps/docs/src/content/docs/recipes/auth/self-hosted-oauth.mdx)
- [OAuth client interoperability release checklist](./oauth-client-interoperability-checklist.md)
- [Integrating a PDP through a capability access rule](./capability-authorization.md)
- [Building an outbound connector](../apps/docs/src/content/docs/recipes/external-provider.mdx)
- [Authoring and composing community capabilities](./capability-composition.md)
- [Installing Action Engines in MCP clients](../apps/docs/src/content/docs/reference/installer.mdx)
- [Scope and maturity matrix](./scope-matrix.md)
- [`hello-engine`: minimal onboarding example](../examples/hello-engine/)
- [`support-engine`: dependency injection and authorization example](../examples/support-engine/)
- [`auth-self-hosted-oauth-engine`: self-hosted OAuth and production deployment example](../examples/auth-self-hosted-oauth-engine/)
- [`support-harness`: private MCP consumer](../examples/support-harness/)
- [`crawl-engine`: outbound Firecrawl connector behind an engine-owned port](../examples/crawl-engine/)
- [`cursor-agent-routing-engine`: versioned Cursor subagent and model routing policy](../examples/cursor-agent-routing-engine/)
- [`image-engine`: multi-provider image production by use case](../examples/image-engine/)
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
acceptance matrix; `AE` means **Action Engine**.

In the event of a conflict, the scope document and the most recent ADRs take
precedence over examples. A change that expands the public API or documented
concepts requires a real use case, a test, and an explicit architectural
decision.

## Reference outcome

An engine must publish the same capability without duplicating business rules:

```text
my-engine list
my-engine describe support.classify-ticket
my-engine run support.classify-ticket --input '{"ticketId":"T-123"}'
my-engine-mcp --transport stdio
my-engine-mcp --transport http --port 3000
```
