# Delivery workflow and acceptance criteria

## Delivery rule

Every executable behavior change follows RED → GREEN → REFACTOR. The test must
fail first for the expected reason, the smallest implementation must make it
pass, and the affected suite must remain green after refactoring. Each
deliverable ends in one validated, cohesive commit containing its tests,
implementation, and documentation.

Documentation-only and mechanical tooling changes may omit RED when no runtime
behavior changes. Their acceptance evidence must still validate links,
formatting, package contents, or the other surface they affect.

## Contract review

Before changing a public API, schema, adapter behavior, event, error, observable
persistence, configuration field, or operational limit:

1. identify the affected `AE-*` requirements and ADRs;
2. define acceptance criteria for success, failure, limits, and compatibility;
3. confirm that CLI and MCP continue to use the single `engine.invoke` path;
4. record a new architectural decision when the change expands or reverses a
   durable boundary; and
5. update documentation in the same deliverable.

## Traceability matrix

| Requirement | Minimum evidence |
| --- | --- |
| `AE-INV-01..04` | A real capability is reused directly, through CLI, and through MCP without duplicating `run` |
| `AE-CAP-01`, `AE-ENG-01` | Type and runtime tests cover the minimal API, IDs supplied as keys, and `list` and `describe` |
| `AE-SCHEMA-01..02` | Valid input and output transform; invalid values produce distinct codes; non-object roots are rejected |
| `AE-ACCESS-01` | Public, authenticated, and function access are covered; denial never calls `run` |
| `AE-CTX-01`, `AE-PRINCIPAL-01` | Context contains only normative fields; identity is validated, snapshotted, and isolated |
| `AE-ARCH-01..03` | Import-graph and inbound-adapter tests prove dependency direction, explicit injection, and the single invocation path |
| `AE-CONNECTOR-00..03` | Public type and runtime tests prove inert connector definition, synchronous Standard Schema transformation, lossless configuration snapshots, opaque dependency identity, frozen named-port containers, sanitized configuration failures, and capability-only publication; representative network and filesystem connectors prove port-only injection, applicable access or operation deadlines, signal propagation, bounded work, domain response translation, sanitized failures, and canary-secret redaction |
| `AE-PIPE-01`, `AE-ERR-01` | Tests instrument stage order, cancellation, timeout, seven codes, and sanitization |
| `AE-OBS-01` | Three minimal events preserve order and contain no payloads or credentials |
| `AE-CLI-01..02` | Integration covers commands, input channels, UTF-8 failure, writers, and exit codes |
| `AE-MCP-01..04` | An official client lists and calls tools over stdio and HTTP; generated MCP engines preflight the published catalog; tests cover schemas, naming collisions, errors, cancellation boundaries, statelessness, and boundary security |
| `AE-MCP-CLIENT-01..03` | Public type tests prove SDK isolation; stdio and HTTP fixtures cover exact descriptors, initialization, pagination, manual calls, cancellation, closure, secure URLs, authentication, and byte limits |
| `AE-SEC-01..02` | Authentication occurs before `invoke`; authorization occurs before `run`; insecure authentication requires explicit opt-in |
| `AE-INSTALL-01..05` | Packed creator smoke tests install a built local engine; target transactions cover confirmation, idempotency, drift, locks, rollback, management, remote descriptors, and secret-free diagnostics without process or network access |
| `AE-CREATE-PROFILE-01..12` | Terminal and non-terminal harnesses cover bounded prompting and confirmation; golden and packed tests cover all four exact profiles, public deploy-owned HTTP bytes, adapter omission, filesystem races, installation order, and direct/CLI/MCP equivalence |
| `AE-DEVTOOLS-01..08` | Doctor fixtures cover exit codes and stack-free diagnostics; a real MCP HTTP host proves single-path execution, fail-closed bearer authentication, origin isolation without CORS headers, bounded tracing, and watch by child-process replacement |
| `AE-DEVTOOLS-ATTACH-01..10` | Inert-startup spies, stdio and HTTP fixtures, hostile local requests, canary secrets, fake clocks, boundary payloads, OAuth callback and cleanup fixtures, accessibility tests, and packed consumers prove explicit read-only verification and bounded manual homologation |
| `AE-DEVTOOLS-ATTACH-CLI-01..15` | Parser cases for `open --cli` / bare `--cli` / `--port`; existing idle-MCP cases stay green; `verify --cli` rejected; inert-startup spies with zero spawn / module load / fetch / discovery; fixture executable for `list` / `describe` / `run` argv (`shell: false`, child exits); fail-closed catalog neighbors including exact 2,000 and exact 10 MiB; describe-failure does not spawn `run`; Run-only `run` spawn; busy second Connect / second verb; no Doctor routes or `inspectEngine`; canary env absent from Activity, session JSON, diagnostics, browser storage, and the project tree |
| `AE-DEVTOOLS-LAUNCH-01..08` | Parser cases for `--mcp` / `--cli` exclusivity and `--port`; launcher fixtures prove the chooser at `/`, both workbench shells with their own API mount, per-workbench browser sessions that do not authorize each other, one shared asset surface, the OAuth callback on the literal loopback root, a refused foreign Host, and both controllers closed with the server; spawned-CLI fixtures prove the ready-line path for the chooser and for each workbench; loopback fixtures prove `localhost` service, every accepted authority, and the walk past a taken port |
| `AE-CREATE-EXAMPLE-01..08` | Injected fetch harnesses cover official short names, GitHub URL resolution, mutual exclusion with `--profile`, confirmation cancellation, package-name rewrite, archive limits, exact nested-subtree link rejection, prefix-neighbor isolation, raw USTAR/PAX/GNU path validation, slash/backslash aliases, POSIX and Windows path escapes, and offline profile network boundaries |
| `AE-CREATE-OPENAPI-01..14` | JSON/YAML and local-reference fixtures cover OpenAPI 3.1.x parsing and rejection of every other version, exact inclusive parse/resolution/schema/witness limits, deterministic endpoint discovery and post-bounding Windows-portable module-name collisions, all-eligible default selection, interactive numbered exclusion, repeatable canonical/operation-ID exclusion, unknown and ambiguous selectors, unsupported reasons, server and security precedence including combined-destination collisions, origin-confined request serialization before credentials, repeated placeholders, non-null parameter and bounded `deepObject` shapes, success response decoding, generated object-root multi-success schemas, executable contract and fake-port-isolation tests for every operation plus successful per-response invocations when bounded input/output witnesses are proven, validation transforms preserve stable response facts, credential-free configuration, rollback, cancellation, and packed generated consumers through every selected adapter |
| `AE-SCOPE-01..04`, `AE-LIMIT-01..08` | Manifest and API review prove package roles and the absence of deferred abstractions |

Supporting packages require focused contract tests for their own authority:
engine, atomic capability, and capability-library creator scaffolds remain
deterministic, non-overwriting, and independently buildable; every creator
emits a valid project-specific development skill; generated capability packages
compose only through the public core API; composition diagnostics remain
deterministic and payload-free;
installer writes remain confirmed, atomic, reversible, and secret-free; deploy
outputs remain deterministic, marked, and non-destructive; and every published
tarball passes an isolated consumer smoke test.

## Release gates

- Documentation distinguishes prompts, rules, skills, loops, graphs, harnesses,
  the Invokta framework, and the shared Action Engine category.
- The core public API remains small, with required schemas and access rules.
- The same capability works directly, through CLI, MCP stdio, and MCP HTTP.
- CLI and MCP call only `engine.invoke`; the official MCP SDK remains isolated.
- Protected HTTP authenticates before `invoke`; authorization occurs before
  `run`; credentials never appear in logs or events.
- Typecheck, lint, formatting, unit and integration tests, build, dependency
  audit, and release-package smoke tests pass in a clean environment.
- Published packages declare the repository license and include it in their
  tarballs.
- Only concepts and package responsibilities permitted by
  [scope and limits](./scope-and-limits.md) are present.
