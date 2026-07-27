# ADR 0002: Standard Schema and Standard JSON Schema as schema contracts

- Status: Accepted
- Date: 2026-07-27

## Context

Capabilities must describe and validate inputs and outputs, while adapters must
expose those contracts to tools and protocols. Tying the public API to a specific
validation library would reduce interoperability and turn an implementation
choice into a requirement for every consumer.

## Decision

Every executable schema accepted by the core will simultaneously conform to the
Standard Schema and Standard JSON Schema contracts. Thus, the same declaration
validates and transforms values at runtime and provides the JSON Schema
representation consumed by the adapters. Version 0.1 will have no custom schema
converter or abstraction.

Input and output will be required, JSON-serializable, and have an object as their
root schema for direct compatibility with MCP tools.

The core and its public types will not export Zod-specific types, classes, or
functions. Zod may appear only in examples, fixtures, and integration tests to
demonstrate that a Standard Schema-compatible implementation works. These
examples do not make Zod a required dependency or the normative source of the
contracts.

Adapters will consume the standard representation provided by the capability;
they will not reconstruct schemas from library-specific metadata.

## Consequences

- Consumers can choose compatible validators without changing the kernel.
- Documentation generation and tool exposure use an interoperable format.
- The core must not assume features exclusive to a particular library.
- Validation and JSON Schema retrieval require contract tests.
- Examples using Zod must be identified as examples, not as the official API.
