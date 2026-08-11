# ADR 0025: Portable MCP tool names

- Status: Accepted
- Date: 2026-08-11

## Context

Invokta capability IDs are domain identifiers such as
`support.classify-ticket`. The MCP adapter previously copied each capability ID
directly into the tool `name`. Some MCP clients, including Claude.ai, exclude
tools whose names do not match `^[a-zA-Z0-9_-]{1,64}$`, so an otherwise valid
engine could connect successfully while exposing none of its dotted
capabilities.

Changing capability IDs would break the direct API, CLI, composition, access,
events, and engine invocation contract. Naming compatibility therefore belongs
at the MCP protocol boundary.

## Decision

`@invokta/mcp` derives one portable MCP tool name for each capability ID when it
constructs the shared protocol server used by stdio and HTTP:

1. Every Unicode code point outside ASCII letters, digits, `_`, and `-` becomes
   `_`.
2. An empty result becomes `_`.
3. A result of at most 64 characters is used directly.
4. A longer result becomes its first 51 characters, `_`, and the first 12
   lowercase hexadecimal characters of the SHA-256 digest of the original
   capability ID encoded as UTF-8.

An ID already matching `^[a-zA-Z0-9_-]{1,64}$` remains unchanged. The adapter
builds a reverse map from the published tool name to the original capability
ID. `tools/list` publishes only the portable name, while `tools/call` resolves
that name and invokes `engine.invoke` with the original ID. Capability
descriptions, access rules, events, direct calls, CLI commands, and composition
continue to use the domain ID.

The adapter validates uniqueness while constructing the protocol server. If
two capability IDs produce the same portable tool name, construction fails with
a deterministic `TypeError`; the adapter neither publishes nor invokes an
ambiguous catalog. This also guards the bounded hash suffix against a digest
prefix collision.

There is no configuration option and no second alias registry. A tool call must
use a name returned by `tools/list`; an old dotted name is not accepted as a
hidden alias.

## Migration

This changes MCP tool names for capability IDs containing unsupported
characters or exceeding 64 characters. MCP clients must refresh `tools/list`,
and integrations that hard-code tool calls must adopt the published name. For
example, `support.classify-ticket` becomes `support_classify-ticket`. Direct API
and CLI callers continue to use `support.classify-ticket`.

Before upgrading, engine authors must also check for collisions such as
`support.echo` and `support_echo`. Rename one domain capability if construction
reports a duplicate portable name. Capability IDs that already satisfy the
portable pattern require no migration.

## Consequences

- Dotted Invokta capabilities remain domain-oriented while becoming visible to
  clients with the stricter tool-name profile.
- Stdio and HTTP share exactly the same publication and reverse-resolution
  behavior.
- Long names remain deterministic and bounded, although their hash suffix is
  less readable than the original ID.
- A colliding catalog fails closed instead of routing a tool call to an
  arbitrary capability.
