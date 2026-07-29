# Implementation plan, TDD, and acceptance criteria

## Delivery rule

Each slice follows RED → GREEN → REFACTOR. The test must fail first for the
expected reason, the minimal implementation must make it pass, and the affected
suite must remain green after refactoring. Each validated deliverable ends in its
own commit containing the corresponding tests, implementation, and documentation.

## Milestones

### M0 — Walking skeleton

Deliver local implementations of `defineCapability` and `createEngine`, a domain
capability with Zod 4, direct invocation, `public`/`authenticated` access, and at
least five tests. Prove DI without a container, rejection of invalid input/output,
and denial before `run`.

### M1 — `@invokta/core`

Deliver public types, Standard Schema + Standard JSON Schema, `EngineError`,
`ExecutionContext`, cancellation/timeout, `onEvent`, inference in `invoke`, an ESM
build, and type/runtime tests. The core cannot import the CLI, MCP, HTTP, AI, or
identity.

### M2 — CLI

Deliver `list`, `describe`, `run`, JSON through an argument/stdin, a local
principal, clean stdout, exit codes, and integration exclusively through
`engine.invoke`.

### M3 — MCP stdio

Deliver tool mapping, input/output schemas, `structuredContent`, error mapping,
cancellation propagation, a local principal, and a test with an MCP client.

### M4 — MCP HTTP and authentication

Deliver stateless `/mcp`, an `authenticate` hook, a Principal per request,
configurable Protected Resource Metadata/challenge, Host/Origin validation, a
secure bind address, and tests with a valid, missing, and invalid token and a
forbidden principal.

### M5 — Examples and documentation

Deliver `hello-engine`, `support-engine`, a direct invocation/CLI/MCP tutorial, an
IdP guide, a function-based PDP guide, and an in-scope/out-of-scope matrix.

### M6 — Validation before expansion

Build two real engines, integrate a harness through MCP, use one capability with
more than one consumer, and record friction points. Future extensions are
evaluated only after this evidence exists; M6 does not expand the API of release
0.1.

## Traceability matrix

| Requirement | Minimum evidence |
| --- | --- |
| `AE-INV-01..04` | Real capability reused directly, through the CLI, and through MCP without duplicating `run` |
| `AE-CAP-01`, `AE-ENG-01` | Type and runtime tests of the minimal API, IDs supplied as keys, and `list`/`describe` |
| `AE-SCHEMA-01..02` | Valid input/output are transformed; invalid values produce distinct codes; non-object root schemas are rejected |
| `AE-ACCESS-01` | `public`, `authenticated`, and a function; denial never calls `run`; access mutation cannot change execution input |
| `AE-CTX-01`, `AE-PRINCIPAL-01` | Context contains only the normative fields; Principal comes from the boundary; malformed identity fails closed; caller/access mutations cannot change the execution identity |
| `AE-ARCH-01..03` | Import graph and adapter tests prove direction and the single path through `invoke` |
| `AE-PIPE-01`, `AE-ERR-01` | Tests instrument order, timeout/cancellation, seven codes, and sanitization |
| `AE-OBS-01` | Three events, minimal fields, duration, and no payload/credential |
| `AE-CLI-01..02` | Integration covers commands, argument/stdin, fatal incremental UTF-8 decoding, awaited and failed stdout/stderr writers, and exit codes 0/1/2 |
| `AE-MCP-01..04` | Official client lists/calls tools over stdio/HTTP; schemas, errors, possible cancellation, statelessness, and Host/Origin protection |
| `AE-SEC-01..02` | 401 before `invoke`; 403 before `run`; spoofing through input fails; insecure auth requires opt-in |
| `AE-SCOPE-01..04`, `AE-LIMIT-01..05` | Manifests and API review prove three packages and the absence of deferred abstractions |

## Final v0.1 gates

- The documentation distinguishes the framework, engine, harness, and loop.
- The core's public API remains small, and schemas/access are required.
- The same capability works directly, through the CLI, MCP stdio, and MCP HTTP.
- The CLI and MCP call only `engine.invoke`; the MCP SDK remains isolated.
- Protected HTTP authenticates before `invoke`; authorization occurs before `run`.
- 401 and 403 retain distinct semantics, and tokens do not appear in logs/events.
- The ESM build, typecheck, lint, unit/integration tests, and package smoke tests
  pass in a clean environment.
- Only the three packages and the concepts permitted by v0.1 exist.
