# M6 validation record

- Date: 2026-07-27
- Scope: validation before expansion
- Public API changes: none

## Evidence produced

Version 0.1 was exercised with two complete private engines and one private MCP
consumer:

| Evidence | Domain capability | Consumers exercised |
| --- | --- | --- |
| `examples/hello-engine` | `onboarding.create-welcome-message` | direct invocation, CLI, MCP stdio, and stateless MCP HTTP |
| `examples/support-engine` | `support.classify-ticket` | direct invocation, CLI, MCP stdio, and stateless MCP HTTP |
| `examples/support-harness` | consumes `support.classify-ticket` | official MCP client over the existing support-engine stdio process |

The support harness owns its messages and tool-execution history. It discovers
the tool before calling it and performs exactly one requested execution. It does
not import the engine, capability, core runtime, or MCP server adapter. It is a
harness responsibility, not an autonomous loop: it does not select another step,
repeat work, or decide when a goal has been reached.

The harness integration test uses the official MCP client. A successful tool
list and call therefore also provide executable evidence that the support-engine
child process keeps stdout protocol-only. The harness process prints its final
JSON snapshot on its own, separate stdout after the MCP subprocess has closed.

## Frictions resolved by version 0.1

### Schema and JSON enforcement

Both engines define Zod 4 object schemas that satisfy Standard Schema and
Standard JSON Schema. The core performs input transformation, access enforcement,
and output validation once. CLI and MCP reuse the resulting JSON contracts; they
do not maintain adapter-specific validation or schema copies. MCP returns the
validated object as `structuredContent` with a serialized text fallback.

This resolved the risk of direct, CLI, and MCP consumers accepting different
payloads. It also confirmed a real constraint: a schema library used by an engine
must implement both standards and expose an object-root JSON schema.

### Process and stdout wrappers

The direct and CLI entrypoints own result rendering, while MCP stdio reserves its
child-process stdout for protocol frames. Starting the stdio entrypoint directly
with Node avoids package-manager status output. Official-client integration tests
detect protocol contamination rather than relying only on a captured string.

The boundary is now explicit and tested, but the small process-entrypoint guards,
generic failure messages, and exit-code assignment remain repeated application
code. That repetition is observable but does not require a framework concept.

### MCP SDK isolation

Custom engines use the neutral `@invokta/mcp` server API and do not depend on
SDK server types. The private harness depends on the official SDK because it is
an MCP client, while the SDK version and protocol compatibility remain isolated
from the core. The support harness has no dependency on any `@invokta/*`
package, which demonstrates that the published protocol is sufficient for an
independent consumer.

### Stateless cancellation boundary

Direct execution and stdio propagate an active invocation signal. Stateless HTTP
propagates disconnection of the active request and creates a fresh server and
transport for every POST. No server, transport, or session survives to receive a
later cancellation message, so cross-request MCP cancellation is intentionally
not promised. The harness needs no workaround for stdio because its client and
server share the lifetime of one connection.

## Repetition observed but not extracted

### Composition

Both engines repeat explicit composition roots for direct, CLI, MCP stdio, and
MCP HTTP entrypoints. This is short, visible wiring, and each engine makes
different trusted-principal and environment decisions. Object composition and
factories still satisfy ownership and dependency injection; no module registry,
container, or lifecycle abstraction is justified.

The two engines make a scaffold eligible for later evaluation, but do not make it
mandatory. A generator now would freeze a recommended folder layout and
entrypoint policy even though the framework intentionally permits smaller or
different custom-engine structures.

### Authentication and authorization

The two HTTP examples repeat a deterministic bearer-token comparison for local
demonstration. It is not a reusable identity implementation and must not be
mistaken for JWT validation, introspection, discovery, or token lifecycle. Only
the support engine exercises a domain permission port, and it does not integrate
a third-party PDP.

The auth-package threshold requires the same OAuth or JWT integration in at
least three engines. The PDP-adapter threshold requires two engines repeating
the same vendor mapping. Neither threshold is met.

### Testing

The engine examples repeat child-process builds, stdout/stderr capture, and
official MCP client setup. The harness adds another MCP client fixture, but it is
not a third engine and it tests a different consumer responsibility. The testing
package threshold requires three engines to repeat the same fakes or assertions;
that threshold is not met.

Small local test helpers remain clearer than a public testing API while the
transport and engine fixtures are still changing.

## Extraction decision

No fourth public package or framework helper was extracted. The private harness
is validation evidence under `examples/`, not a product package or proposed
harness API. The observed repetition is either application composition, below an
explicit evidence threshold, or intentionally outside framework scope.

| Candidate | Current evidence | Decision |
| --- | --- | --- |
| Engine scaffold | Two in-repository engines; different domain wiring | Eligible for later evaluation, not extracted |
| Testing helpers | Two engines plus one non-engine consumer | Three-engine threshold not met |
| OAuth/JWT auth package | Two local token comparisons; no real shared IdP integration | Three-engine threshold not met |
| PDP adapter | One local permission port; no vendor mapping | Two-engine same-vendor threshold not met |
| Runtime modules or lifecycle | Factories and object composition remain sufficient | No operational trigger |
| Harness package | One private protocol consumer | Explicitly outside the v0.1 framework |

This validation supports expansion decisions; it does not establish production
maturity. The deterministic examples do not claim provider quality, evaluation
coverage, cost control, incident readiness, or protection by a production IdP.
