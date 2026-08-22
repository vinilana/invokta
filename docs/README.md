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
  [ADR 0020](./adr/0020-github-example-import-for-engine-creator.md), amended
  with portable path and selected-subtree validation by
  [ADR 0035](./adr/0035-example-archive-path-and-subtree-validation.md)
- Engine devtools dev server —
  [ADR 0021](./adr/0021-engine-devtools-dev-server.md)
- MCP installation inspection and homologation —
  [ADR 0022](./adr/0022-mcp-installation-inspection-and-homologation.md),
  extended with ephemeral OAuth by
  [ADR 0023](./adr/0023-ephemeral-oauth-for-installed-mcp-inspection.md) and
  amended with advertised authorization servers and discovery inspection by
  [ADR 0031](./adr/0031-oauth-discovery-inspection-and-advertised-servers.md)
- Production MCP OAuth integration boundary —
  [ADR 0024](./adr/0024-production-mcp-oauth-integration-boundary.md)
- Portable MCP tool names —
  [ADR 0025](./adr/0025-portable-mcp-tool-names.md)
- Generated engine MCP conformance gate —
  [ADR 0026](./adr/0026-generated-engine-mcp-conformance-gate.md)
- Windows installer ownership identity —
  [ADR 0027](./adr/0027-windows-installer-ownership-identity.md)
- Adapter emulation in the engine devtools —
  [ADR 0028](./adr/0028-adapter-emulation-in-engine-devtools.md), extended with
  selectable HTTP authentication by
  [ADR 0029](./adr/0029-selectable-http-authentication-in-devtools.md) and with
  project entry points by
  [ADR 0030](./adr/0030-project-entry-points-in-devtools-emulation.md)
- CLI installation inspection and homologation —
  [ADR 0032](./adr/0032-cli-installation-inspection-and-homologation.md),
  superseded on workbench entry and selection by
  [ADR 0033](./adr/0033-workbench-launcher-and-selection.md)
- Workbench launcher and workbench selection —
  [ADR 0033](./adr/0033-workbench-launcher-and-selection.md)
- Harness configuration variants and VS Code remote user scope —
  [ADR 0034](./adr/0034-harness-config-variants-and-vscode-remote-user-scope.md)
- Engine-owned outbound connectors through explicit ports —
  [ADR 0036](./adr/0036-engine-owned-outbound-connectors.md)
- Typed connector definitions with explicit port injection —
  [ADR 0037](./adr/0037-typed-connector-definitions.md)
- Guided OpenAPI capability import —
  [ADR 0038](./adr/0038-guided-openapi-capability-import.md)

## Design notes

Proposals under review. They are not delivered behavior and do not override a
contract or ADR; each one records the boundary it would need before it becomes
an architecture decision.

- [Connector brokers and request-time credentials](./connector-brokers.md) —
  integrating Vercel Connect or another connector broker without extending the
  core

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
