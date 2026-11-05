# ADR 0046: Stability policy, capability deprecation, and contract diff

- Status: Accepted
- Date: 2026-11-05

## Context

Invokta is at `0.9.x` without a written stability, compatibility, or
deprecation policy, and without criteria for 1.0. Users cannot tell which
surfaces are public, what a minor release may change, or how long a deprecated
feature remains.

Engines face the same gap one level up. The Action Engine definition calls an
engine versioned, but only the engine has a `version` string. A capability
cannot announce that it is deprecated, so consumers learn about a removal when
calls fail. Nothing helps an engine author notice that a release breaks a
capability contract: a new required input property, a removed output property,
or a stricter access rule passes every existing check.

## Decision

### Stability policy

[docs/stability-policy.md](../stability-policy.md) is the normative policy. It
lists the public surface of each package, applies Semantic Versioning with the
`0.y.z` rule before 1.0, requires a `@deprecated` tag, reference note, and
`Deprecated` changelog entry for every framework deprecation, keeps deprecated
APIs for at least one minor release before 1.0 and until the next major release
from 1.0, states the supported Node.js range and the MCP baseline update rules
of ADR 0006, describes how security fixes ship, and lists the criteria for 1.0
without a date. It also classifies capability contract changes for engine
authors.

### Capability deprecation

Capability definitions accept an optional
`deprecated: { reason, since?, replacement? }` field (`CapabilityDeprecation`).
`createEngine` reads it once with the other top-level fields and validates it
synchronously: it must be a plain record of enumerable own data properties
named `reason`, `since`, or `replacement`; each present value must be a
non-blank string of at most 1,024, 64, and 256 characters respectively, and
`reason` is required. An explicitly `undefined` optional field is treated as
absent. Accessors, proxies, symbols, and unknown fields fail construction with
`TypeError` without running caller code. The validated notice is copied and
frozen.

`replacement` is free text, usually a capability ID. The core does not require
it to name a capability of the same engine, because composition may remap IDs
and a replacement may live in another engine.

`list()` and `describe()` include the notice. Invocation behavior, events, and
errors do not change. On the first invocation of each deprecated capability in
an engine instance, the runtime calls
`logger.warn("Deprecated capability invoked.", { capabilityId, requestId,
since?, replacement? })` once, after resolving the capability and before input
validation, so rejected calls are also visible. A throwing or rejecting logger
is contained like the existing event diagnostics. A construction-time warning
was rejected because the author already knows the capability is deprecated, and
it would add stderr noise to every CLI command and stdio start; the first-use
warning tells an operator that a consumer still depends on it.

`@invokta/mcp` keeps one tool per capability. For a deprecated capability, the
tool description starts with `Deprecated[ since <since>]: <reason>`, followed by
`Replacement: <replacement>` when present, a blank line, and the original
description, so every client and model sees the notice. The same notice is
published as `_meta["dev.invokta/deprecated"]`, a reverse-DNS key outside the
MCP-reserved prefixes, for clients that read structured metadata. Calls are
unchanged. The CLI prints the notice because `list` and `describe` print the
engine's snapshots.

### Published access kind

`describe()` adds a required `access` field with the type
`CapabilityAccessKind = "public" | "authenticated" | "function"`. A function rule
remains opaque; only its kind is published. Access is part of the contract a
caller depends on, and the contract snapshot must capture it from a constructed
engine. `list()` and the MCP tool listing do not include it.

### Contract snapshot and diff

`@invokta/tooling` adds two commands:

- `invokta contract snapshot <esm-module> [--export <name>] [--output <file>]`
  imports a built module like `check-mcp`, selects the `engine` export by
  default, and writes a deterministic JSON snapshot through `list` and
  `describe` only. The snapshot has `formatVersion: 1`, the engine name and
  version, and each capability's title, description, access kind, timeout,
  boolean annotation hints, deprecation notice, and input and output JSON
  Schemas. Capability IDs and JSON Schema keywords are sorted by code unit, so
  declaration and keyword order never change the bytes.
- `invokta contract diff <previous> <next> [--fail-on-potentially-breaking]`
  reads two snapshots and writes a report grouped as breaking, potentially
  breaking, and compatible. Each change carries a stable code, the capability
  ID, and a JSON Pointer into the input or output schema when applicable.

The comparison treats an input schema as what the engine must keep accepting
and an output schema as what it must keep promising. Narrowing an input or
widening an output is breaking; the opposite is compatible. It decides `type`
(with `integer` inside `number`), `enum` and `const`, numeric and count bounds,
`uniqueItems`, the addition or removal of `pattern` and `multipleOf`,
`properties`, `required`, `additionalProperties`, and `items`, recursively.
Every other keyword change, including `$ref`, `$defs`, `anyOf`, `oneOf`,
`allOf`, `not`, conditionals, `format`, `default`, and a replaced `pattern`, is
potentially breaking rather than guessed. Adding an output property is
compatible even for a closed output object, because the policy requires
consumers to tolerate unknown output properties; schema libraries routinely
close output objects, and classifying every added field as a break would hide
real breaks. Capability-level rules cover removal and addition (a rename is
both), access, timeout, annotation guarantees, deprecation, documentation, and
the engine name.

`contract diff` exits `0` without breaking changes, `1` with breaking changes
(or potentially breaking changes under the flag), and `2` for usage errors and
unreadable or invalid snapshots. Snapshots are limited to 16 MiB, schema
documents to 256 levels of nesting, and unknown snapshot fields are rejected so
an older tool never compares a newer snapshot partially. Invalid JSON is
reported without echoing parser messages, which can quote file content. The
package root exports `runContractCommand`, `createContractSnapshot`,
`serializeContractSnapshot`, `diffContractSnapshots`, and their types.

## Consequences

- Users have a written public API boundary, deprecation window, and 1.0
  criteria; release preparation can classify each change against them.
- Engine authors can deprecate a capability and see that consumers still use
  it, without changing invocation behavior or adding a lifecycle.
- `describe()` and CLI `describe` output gain `access`. Code that asserts exact
  equality of a description must add the field; hand-written `Engine`
  implementations must return it.
- CI can gate engine releases on contract compatibility. The diff is a
  structural check: handler semantics, function access logic, and quality are
  out of its reach, and undecidable schema changes need human review.
- The snapshot format is a public, versioned contract of the tooling. Adding a
  field to it, such as declared domain errors, is a later extension of this
  format.
- No runtime execution path, adapter, error code, event, or pipeline stage is
  added.
