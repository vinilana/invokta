# Invokta documentation

The Invokta framework allows a domain capability to be defined once and
executed through a direct call, the CLI, MCP stdio, and stateless MCP Streamable
HTTP.

The broader [Action Engines community definition](./action-engines.md) is
framework-neutral and intended for independent adoption. Invokta's normative
contracts below define one implementation of that concept.

## Reading order

1. [Action Engines community definition](./action-engines.md)
2. [Vision and invariants](./vision-and-invariants.md)
3. [Architecture and contracts](./architecture.md)
4. [Scope and limits](./scope-and-limits.md)
5. [Delivery workflow and acceptance criteria](./implementation-plan-and-acceptance-criteria.md)
6. [Architecture decision records](./adr/README.md)
7. [Validation record](./validation-record.md)

## Delivered changes

Each delivered change is normative through its accepted architecture decision:

- Engine-scoped MCP uninstall —
  [ADR 0017](./adr/0017-engine-scoped-mcp-uninstall.md)
- Interactive engine creator profiles —
  [ADR 0018](./adr/0018-interactive-engine-creator-profiles.md)
- GitHub example import for `create-invokta-engine` —
  [ADR 0020](./adr/0020-github-example-import-for-engine-creator.md)
- Engine devtools dev server —
  [ADR 0021](./adr/0021-engine-devtools-dev-server.md)
- MCP installation inspection and homologation —
  [ADR 0022](./adr/0022-mcp-installation-inspection-and-homologation.md),
  extended with ephemeral OAuth by
  [ADR 0023](./adr/0023-ephemeral-oauth-for-installed-mcp-inspection.md)
- Production MCP OAuth integration boundary —
  [ADR 0024](./adr/0024-production-mcp-oauth-integration-boundary.md)
- Portable MCP tool names —
  [ADR 0025](./adr/0025-portable-mcp-tool-names.md)
- Generated engine MCP conformance gate —
  [ADR 0026](./adr/0026-generated-engine-mcp-conformance-gate.md)

## Guides and examples

These guides apply the normative contracts above. When a guide or example
conflicts with a contract or ADR, the normative source takes precedence.

- [Getting started: direct, CLI, MCP stdio, and MCP HTTP](./getting-started.md)
- [File naming and project structure for custom engines](../apps/docs/src/content/docs/guides/file-naming.mdx)
- [Integrating an identity provider at the HTTP boundary](./http-authentication.md)
- [Self-hosted OAuth recipe](../apps/docs/src/content/docs/recipes/auth/self-hosted-oauth.mdx)
- [OAuth client interoperability release checklist](./oauth-client-interoperability-checklist.md)
- [Integrating a PDP through a capability access rule](./capability-authorization.md)
- [Authoring and composing community capabilities](./capability-composition.md)
- [Installing Action Engines in MCP clients](../apps/docs/src/content/docs/reference/installer.mdx)
- [Scope and maturity matrix](./scope-matrix.md)
- [`hello-engine`: minimal onboarding example](../examples/hello-engine/)
- [`support-engine`: dependency injection and authorization example](../examples/support-engine/)
- [`auth-self-hosted-oauth-engine`: self-hosted OAuth and production deployment example](../examples/auth-self-hosted-oauth-engine/)
- [`support-harness`: private MCP consumer](../examples/support-harness/)
- [`crawl-engine`: outbound provider integration with Firecrawl](../examples/crawl-engine/)
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
