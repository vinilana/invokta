# ADR 0020: Engine devtools dev server

- Status: Accepted
- Date: 2026-08-05

## Context

Engine authors have no interactive development surface. Every generated entry
point executes built output directly, invoking a capability requires
hand-written JSON although `describe` publishes complete JSON Schemas,
observing an engine as an MCP client requires manual JSON-RPC framing or an
SDK test dependency, the composition root fixes one principal so access rules
cannot be exercised as another actor without rebuilding, and no supporting
tool consumes the `onEvent` hook.

Existing supporting applications are non-interactive generators and
validators. A development server must execute capabilities, which their
charters prohibit, so the capability must be granted deliberately without
weakening the single execution path, the closed event surface, or the closed
package list.

## Decision

Invokta publishes a tenth native ESM package, `@invokta/devtools`, a
binary-only supporting application exposing the `invokta-devtools` executable
with `doctor` and `serve` commands. This decision supersedes the nine-package
count established by ADR 0014, ADR 0012, and ADR 0004 while preserving their
dependency direction and package isolation.

The devtools depends only on the public APIs of `@invokta/core` and
`@invokta/mcp` and Node.js built-ins. No runtime package depends on it, and
it depends on no other supporting package. This adds the dependency edges
`devtools → core` and `devtools → mcp` to the package graph.

`serve` loads an explicitly named built engine module, verifies it through
read-only doctor checks, and hosts it with the unmodified `serveMcpHttp`
adapter bound to loopback, so every capability execution traverses
`engine.invoke` with source `mcp-http`. Authentication always runs in
`required` mode with a devtools-owned hook that maps minted opaque bearer
tokens to in-memory development principals; the disabled mode is never used.
A local web interface is served from a single loopback origin that proxies
`POST /mcp` to the engine host, because the adapter intentionally emits no
cross-origin headers.

Observation uses a delegating wrapper around the public engine surface that
records timing and outcome without altering arguments, results, or errors.
The core `onEvent` hook, its three events, and its payload-free contract are
unchanged; the trace is a bounded in-memory buffer scoped to one process, and
request or response payloads are captured only from exchanges the devtools
proxy itself carries.

The devtools is granted a bounded process-spawning surface, unlike the
installer and deploy applications: it may spawn its own engine-host child
process and, in watch mode, the explicit build command supplied by the
developer. Watch mode applies changes only by replacing the child process
after that build succeeds. In-process module reloading remains prohibited.

The devtools MUST NOT add an `ExecutionContext.source` value, a second
cross-cutting hook, or events beyond the existing three; MUST NOT persist,
aggregate, or export invocation data; MUST NOT discover engines, scan
directories, or read configuration to locate modules; MUST NOT bind a
non-loopback interface; MUST NOT implement MCP resources, prompts, sampling,
elicitation, tasks, stateful sessions, resumption, or server-to-client
requests; MUST NOT provide evaluation, judging, release gating, or replay;
and MUST NOT write to the developer's project.

Normative behavior is specified in the
[engine devtools dev server specification](../specs/engine-devtools-dev-server.md).

## Consequences

- `invokta-devtools serve dist/engine.js` gives a generated engine an
  invocation playground, raw MCP inspection, a live trace, principal
  switching, and doctor diagnostics without new runtime concepts.
- The supporting-package count in the scope documents becomes seven and the
  published-package count becomes ten.
- The MCP HTTP adapter remains the only execution boundary the devtools
  touches; removing or changing the adapter contract requires revisiting this
  decision.
- Trace evidence is development-scoped by construction; an observability
  package still requires the evidence demanded by the scope documents.
- Extending the devtools with persistence, remote access, multi-engine
  management, or an eval surface requires another architectural decision.
