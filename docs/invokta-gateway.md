# Invokta Gateway: framework boundary

- Status: Design note. The application is developed in its own private
  repository, `invokta-gateway`; this note records only what touches the
  framework and why the application lives outside it.
- Date: 2026-09-02
- Applies to: `@invokta/mcp`, `@invokta/deploy`, and the maintainer documents

**Invokta Gateway** is a web application that lets an operator create and
configure Action Engines without writing code. The operator registers an
authenticated REST or GraphQL API as a *connector*, chooses which endpoints or
operations each engine exposes, and publishes the engine as its own MCP
Streamable HTTP server. Consumers authorize their MCP client against the
gateway with OAuth and call the published capabilities. Better Auth provides
login, organizations, and the OAuth authorization server; Vercel Connect is the
first supported credential broker for upstream APIs.

## Why it lives outside the framework

| Question | Answer |
| --- | --- |
| Is the gateway an Action Engine? | No. It is a host that *produces* Action Engines from configuration. Each published engine qualifies under the [community definition](./action-engines.md): domain-named capabilities, validated contracts, one access rule, replaceable upstream implementation, independent consumers. |
| Is it a framework package? | No. `AE-SCOPE-01` stays at ten packages. The gateway consumes the published `@invokta/core` and `@invokta/mcp` from its own repository, so the framework's scope, dependency audit, and release gates are untouched. |
| Does it add a connector registry, container, or plugin system to Invokta? | No. Connector kinds are compiled into the gateway; the gateway composes engines explicitly at its own composition root with `createEngine`, `defineCapability`, and `defineConnector`. `AE-LIMIT-02` and `AE-LIMIT-03` continue to describe the framework. |
| Is it the level E platform the scope matrix excludes? | It is the first application that needs level E concerns, which is exactly why it must live outside the framework. |
| Which example is the closest precedent? | [`auth-self-hosted-oauth-engine`](../examples/auth-self-hosted-oauth-engine/): a host-owned authorization server, PostgreSQL persistence, `node:http` servers, and Invokta as the resource server boundary (ADR 0024). |

## Contracts the gateway consumes

| Contract | Use in the gateway | Source |
| --- | --- | --- |
| `defineCapability`, `createEngine`, `engine.invoke`, `list`, `describe` | Build and execute every capability; the web playground and the MCP endpoint share this path | ADR 0001, ADR 0003, ADR 0005 |
| Standard Schema and Standard JSON Schema | Stored JSON Schema contracts become runtime validation and MCP tool descriptions | ADR 0002 |
| `defineConnector` | One typed factory per connector kind; capabilities receive only the port they use | ADR 0036, ADR 0037 |
| `serveMcpHttp` with required authentication, `resourceMetadata`, `challengeScopes`, `allowedHosts`, and `path` | One MCP server per published engine, several per origin | ADR 0007, ADR 0024, ADR 0039 |
| `validateMcpToolCatalog` and `toMcpToolName` | Publish gate; tool names shown in the UI | ADR 0025, ADR 0026 |
| `onEvent` | Payload-free activity log | ADR 0003 |
| `connectMcpClient`, `beginMcpOAuthAuthorization`, `inspectMcpOAuth` | End-to-end tests against a running gateway | ADR 0023, ADR 0031 |
| `invokta-deploy probe` and `inspect-oauth` | Deployment checks per mounted engine | ADR 0011, ADR 0039 |
| `EngineError` with the seven codes | The only failure vocabulary connectors may raise | ADR 0003 |
| `CredentialSource<Credential>` | Engine-owned port for request-time credentials, with static and Vercel Connect implementations | [connector brokers](./connector-brokers.md) |

## The framework change

One published engine is one `serveMcpHttp` instance with its own RFC 9728
Protected Resource Metadata and its own audience-bound access tokens. ADR 0007
fixed the route at `/mcp`, so two engines could not share one origin.
[ADR 0039](./adr/0039-configurable-mcp-http-mount-path.md) adds the optional
`path` option: a canonical absolute path ending in `/mcp`, validated before
listening, with the metadata document at the RFC 9728 path-suffix location.
The gateway front server proxies `/e/<slug>/mcp` to each engine's loopback
port, preserving the raw `Host` header so ADR 0007's host and origin defenses
still apply at the engine.

That is the only framework change the MVP needs. Everything else the gateway
requires is host-owned under `AE-SCOPE-03`:

- Better Auth as the operator identity and the OAuth 2.1 authorization server,
  with one persisted OAuth resource per published engine;
- token verification inside each engine's `authenticate` hook, following
  [`auth-better-auth-engine`](../examples/auth-better-auth-engine/);
- PostgreSQL persistence, encrypted secrets, and plain SQL migrations;
- the REST and GraphQL connector kinds, the capability factory, and the
  organization-membership access rule;
- the `CredentialSource` port with its static and Vercel Connect
  implementations; and
- the reverse proxy, deployment container, and activity log.

## What the gateway does not ask of the framework

- No `context.connectors`, credentials, or metadata bag on `ExecutionContext`
  (`AE-CTX-01`).
- No new error code: a missing broker grant maps to `FORBIDDEN` with a
  recovery URL in public details, as the connector-brokers note prescribes.
- No runtime registration, discovery, or lifecycle for connectors
  (`AE-LIMIT-02`).
- No handler-style or serverless MCP adapter. The gateway runs as one
  long-running container; mounting an engine inside a host-owned server is a
  separate decision.
- No framework identity implementation (`AE-LIMIT-04`).

## Evidence the gateway will produce

`AE-SCOPE-04` evolves the framework by extraction. A deployed gateway is one
independent consumer for three candidates that currently lack evidence:

| Candidate | What the gateway exercises |
| --- | --- |
| Connector-broker port or package (connector-brokers note) | `CredentialSource` with a static and a Vercel Connect implementation across many generated engines |
| Authentication package (scope matrix) | The same JWKS-based Better Auth verification repeated per hosted engine |
| Handler-style MCP adapter | The proxy that ADR 0039 makes necessary, and any serverless hosting requirement |

Each remains gated on the evidence the scope matrix and ADR 0024 require; the
gateway supplies one data point, not a decision.
