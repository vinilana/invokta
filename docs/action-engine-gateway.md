# Action Engine gateway

- Status: Proposal with a private proof of concept in
  [`packages/gateway`](../packages/gateway/). Not delivered behavior. Promote
  to an ADR before publishing the package or changing any normative contract.
- Date: 2026-11-07
- Applies to: a new `@invokta/gateway` package; no change to `@invokta/core`,
  `@invokta/mcp`, or `@invokta/http`

An **Action Engine gateway** publishes the capabilities of several Action
Engines and MCP servers through one endpoint and enforces the authentication
and authorization rules that the team operating the gateway configures.

This note answers four questions:

1. Can a gateway be built on the existing contracts without a second
   execution path?
2. Where do authentication, authorization, and upstream credentials belong?
3. How do clients discover tools when a gateway publishes hundreds of them?
4. Which accepted limits does a gateway touch, and what must an ADR decide
   before the package ships?

## Summary of the recommendation

**The gateway is a capability map, not a new runtime.** `createGateway`
turns explicitly configured upstreams into ordinary capabilities whose `run`
forwards to the upstream `engine.invoke` or MCP `tools/call`, and whose
`access` comes from the gateway's rules. The host passes that map to
`createEngine` and serves the resulting engine with the existing adapters:

```text
agent / app ──> MCP HTTP or HTTP JSON adapter ──authenticate──> gateway engine.invoke
                                                                  │ validate (structural)
                                                                  │ access = gateway rule
                                                                  └─ run ──┬─> upstream engine.invoke  (its own validation + access)
                                                                           └─> upstream MCP tools/call (service credential)
```

Consequences:

- **One execution path.** Every adapter still calls only `engine.invoke`
  (AE-ARCH-03). The gateway adds no adapter, transport, error code, event,
  context field, or pipeline stage.
- **Two enforcement points.** The gateway's rule runs as the capability's
  `access` stage; an upstream engine still runs its own `access` afterwards.
  The gateway can only narrow access, never widen it.
- **Everything composes.** `onEvent`, `@invokta/otel`, `applyMiddleware`
  (rate limits, quotas, caching), `@invokta/tooling`, the CLI, MCP stdio, the
  devtools, and the installer work on a gateway engine unchanged.

The proof of concept implements this design in about 1,200 lines of source
without changing an existing package.

For catalogs of hundreds of tools, the plan adds per-caller visibility
(option D, phase 2) and opt-in search-based discovery (option C, phase 3). D
is the only planned change to existing packages: an optional adapter option.
See [Tool discovery at scale](#tool-discovery-at-scale).

## Evidence

The proposal follows the extraction rule of AE-SCOPE-04 and must meet it
before an ADR:

| Evidence | Where |
| --- | --- |
| Hosts already publish several engines behind one origin as a "Gateway" resource | ADRs [0039](./adr/0039-configurable-mcp-http-mount-path.md) and [0040](./adr/0040-installer-mounted-mcp-urls.md), issue #75 |
| Engines repeat the same authentication integration | ADR [0049](./adr/0049-jwt-bearer-authentication-helper.md): nine authentication examples |
| A plain-type MCP client facade already exists | `connectMcpClient` in `@invokta/mcp` |
| Consumers must install and authenticate every engine separately | `@invokta/installer` manages one entry per engine and client |

Still missing, and required before promotion: at least two real deployments
that aggregate upstreams they do not own, and a decision on the tensions
listed under [Relationship to accepted contracts](#relationship-to-accepted-contracts).

## Topologies

| Topology | What the consumer sees | Status |
| --- | --- | --- |
| **Aggregating** (fan-in) | One MCP server or HTTP API whose catalog combines namespaced capabilities from every upstream | Implemented by the proof of concept |
| **Mounting** (multiplexing) | One origin with one endpoint per engine, for example `/e/billing/mcp`, each with its own audience and Protected Resource Metadata | Possible today with ADR 0039 and 0042 handlers; a router helper is phase 5 |

Aggregation is the gateway proper: one installation, one credential, and one
policy for many engines. Mounting keeps one resource identifier per engine
and suits audience-bound OAuth tokens. Both are host compositions over the
same adapters.

## Architecture

```mermaid
flowchart LR
  CLIENT[Agent or application] --> ADAPTER[MCP HTTP / HTTP JSON / stdio / CLI]
  ADAPTER --> AUTHN[authenticate hook\nchainAuthenticators]
  AUTHN --> INVOKE[gateway engine.invoke]
  INVOKE --> VALIDATE[structural input check]
  VALIDATE --> RULE[gateway rule as access]
  RULE --> RUN[proxy run]
  RUN --> LOCAL[upstream engine.invoke]
  RUN --> MCP[upstream MCP tools/call]
  LOCAL --> UACCESS[upstream validation and access]
  MCP --> USERVER[upstream MCP server]
```

### Request lifecycle

1. The adapter validates Host, Origin, route, method, and body bounds as it
   does today.
2. The adapter's `authenticate` hook returns a `Principal` or `null`.
   `chainAuthenticators` lets one gateway accept several methods, for example
   `@invokta/auth-jwt` for users and `apiKeyAuthenticator` for services.
3. `engine.invoke` resolves the gateway capability and runs the structural
   input check.
4. The capability's `access` is the gateway rule bound at construction. A
   throwing rule is a denial, never an execution failure. The decision is
   reported to `onDecision` without input, output, or credentials.
5. `run` forwards to the upstream with the caller's signal; for an engine
   upstream also the request ID, the mapped principal, and the progress sink.
6. The upstream result is returned; an upstream `DOMAIN_ERROR` is raised again
   as the same declared domain error, and every other failure keeps its public
   code or is normalized by the core.

## Configuration surface (proof of concept)

```ts
import { createEngine } from "@invokta/core";
import { serveMcpHttp, connectMcpClient } from "@invokta/mcp";
import { createJwtBearerAuthenticator } from "@invokta/auth-jwt";
import {
  apiKeyAuthenticator,
  chainAuthenticators,
  createGateway,
  engineUpstream,
  mcpUpstream,
  requireScopes,
} from "@invokta/gateway";

const gateway = createGateway({
  upstreams: [
    engineUpstream({ name: "support", engine: supportEngine }),
    await mcpUpstream({
      name: "docs",
      namespace: "kb",
      connection: await connectMcpClient(docsTarget),
      include: ["search", "fetch"],
      pin: process.env.DOCS_CATALOG_FINGERPRINT,
      timeoutMs: 10_000,
    }),
  ],
  rules: [
    { name: "no-deletes", match: "kb.delete", access: "deny" },
    { name: "kb-read", match: "kb.*", access: requireScopes("kb:read") },
    { name: "support", match: "support.*", access: "authenticated" },
  ],
  // defaultAccess: "deny" is the default.
  onDecision: (decision) => audit.write(decision),
});

const engine = createEngine({
  name: "acme-gateway",
  version: "1.0.0",
  capabilities: gateway.capabilities,
});

await serveMcpHttp(engine, {
  auth: {
    mode: "required",
    authenticate: chainAuthenticators(
      createJwtBearerAuthenticator(jwtOptions),
      apiKeyAuthenticator({ keys: serviceKeys }),
    ),
  },
});
```

| Export | Responsibility |
| --- | --- |
| `engineUpstream` | Snapshot an in-process engine's catalog through `list` and `describe`; forward to its `invoke` |
| `mcpUpstream` | Snapshot a connected MCP server's tools once, with bounded pagination and an optional pinned fingerprint; forward to `callTool` |
| `createGateway` | Bind each capability to its first matching rule; return the capability map and the route table |
| `chainAuthenticators` | Try several `authenticate` hooks in order |
| `apiKeyAuthenticator`, `hashApiKey` | Static service keys stored as SHA-256 digests |
| `requireScopes` | Access function over `principal.attributes.scopes`, the `@invokta/auth-jwt` default mapping |

## Authentication

Authentication stays where ADR 0007 put it: the HTTP adapters' required
`authenticate` hook, before `engine.invoke`. The gateway adds only
composition:

- `chainAuthenticators` returns the first non-null principal. A method that
  throws stops the chain, so an unavailable key set yields the adapter's
  sanitized 500 instead of a silent fallback to a weaker method.
- `apiKeyAuthenticator` accepts one header (default `x-api-key`), keeps only
  digests in configuration, bounds the presented key to 1,024 characters, and
  compares against every digest without an early exit.
- Local channels (stdio, CLI, direct) keep the host-supplied principal of
  AE-CLI-01 and AE-MCP-03.

The gateway does not issue tokens, perform login, or introspect tokens
(AE-LIMIT-04).

## Authorization

A rule is `{ name?, match, access }`. `match` is an exact capability ID,
`prefix.*`, or `*`. `access` is `public`, `authenticated`, `deny`, or a
function receiving `{ principal, input, context, route }`. Semantics:

- **First match wins**, in configuration order, like a firewall rule list.
  Binding happens once, at construction, and `gateway.routes` publishes which
  rule governs every capability so the policy can be reviewed and snapshot
  tested.
- **Deny by default.** Unmatched capabilities get `defaultAccess`, which is
  `deny` unless configured.
- **Fail closed.** A rule that throws or rejects denies and logs a
  payload-free warning; the outcome is reported as `failed`.
- **Strict configuration.** A rule or `include` pattern that matches nothing
  fails construction, so a typo cannot silently drop a deny rule.
- **Defense in depth.** An engine upstream still enforces its own `access`.
  `principal` on `engineUpstream` maps the gateway caller to the identity the
  upstream receives.

This is a routing table that assigns an access rule to each capability. The
decisions themselves remain functions or core access kinds; a rule may call a
PDP exactly as [capability authorization](./capability-authorization.md)
describes.

## Upstreams

### Engine upstream

- The catalog is read once from `list` and `describe`; `include` narrows it.
- Contracts are republished unchanged: title, description, schemas,
  annotations, deprecation, and declared domain errors.
- `run` calls the upstream `engine.invoke` with the gateway request ID,
  source, mapped principal, signal, and progress sink, so upstream validation,
  access, timeout, events, and progress all apply.
- The core never preserves a thrown `DOMAIN_ERROR`, so the gateway redeclares
  each upstream domain error and raises it again as a `CapabilityError`; the
  caller sees the same code, retry hint, and details.

### MCP upstream

- The host owns the MCP client connection, its credentials, and its lifetime.
  The gateway depends only on a structural `listTools`/`callTool` interface
  that `McpClientConnection` satisfies, so the package does not depend on the
  MCP SDK.
- Discovery runs once at the composition root: at most 64 pages and
  `maxTools` tools (default 256, at most 4,096). A duplicate tool name or an
  input or output schema without an object root fails startup.
- The gateway publishes `<namespace>.<tool>`; the namespace defaults to the
  upstream name.
- `fingerprint` is the SHA-256 of the canonical JSON of the published tools.
  With `pin`, any change to a tool's name, description, schemas, or
  annotations fails startup: a defense against MCP tool poisoning and silent
  description changes.
- Every tool call has a finite timeout (default 30,000 ms) and receives the
  invocation signal (AE-CONNECTOR-02).
- A tool with an output schema returns its `structuredContent`; one without
  returns `{ content }`. A tool error becomes the declared domain error
  `UPSTREAM_TOOL_ERROR` with the first text block, truncated to 1,024
  characters.

### Upstream credentials

The caller's credential is **never forwarded** to an upstream. Passing an
inbound token through creates a confused deputy and breaks audience binding;
the MCP authorization specification forbids it. In the proof of concept each
MCP upstream uses one service credential held by the host. Per-caller
upstream credentials, through token exchange or a connector broker, are
phase 6 and reuse the `CredentialSource` port of
[connector brokers](./connector-brokers.md).

## Tool discovery at scale

The gateway discovers upstream tools once, at startup (see
[MCP upstream](#mcp-upstream)). Clients have no comparable mechanism: every
caller receives the complete published catalog in one `tools/list` response,
including capabilities it is not allowed to call.

### Measured baseline

Measured with the proof of concept against a real upstream MCP engine whose
tools have one-line descriptions and two-property input schemas. Token counts
use a rough estimate of 4 bytes per token; real tools with longer
descriptions and schemas cost several times more.

| Upstream tools | Configuration | Startup discovery | One client `tools/list` |
| --- | --- | --- | --- |
| 200 | default | 182 ms | 200 tools, about 97 KB (about 24,000 tokens) |
| 300 | default | Fails: more than the default 256 tools | — |
| 300 | `maxTools: 500` | 110 ms | 300 tools, about 145 KB (about 36,000 tokens) |
| 200 or 300 | `include` of 3 tools | — | 3 tools |

Hundreds of tools consume the client's context in every conversation and
degrade the model's tool selection. Some clients, such as Claude Code, defer
large MCP tool sets and search them on demand; the gateway cannot rely on
every client doing so.

### Options considered

| Option | Mechanism | Plan |
| --- | --- | --- |
| A — Curation | `include` per upstream | Available in the proof of concept |
| B — Profiles per audience | One mount per audience with its own subset | Covered by the mounting router (phase 5) for audience-bound OAuth, not as the discovery answer |
| **C — Search-based discovery** | The client sees a constant, small set of tools and searches the catalog on demand | **Planned: phase 3** |
| **D — Per-caller visibility** | Each caller lists, describes, and calls only capabilities its rules can allow | **Planned: phase 2** |

D comes first because C depends on it: search results must never include a
capability the caller cannot see.

### D — Per-caller visibility

**Goal.** A caller lists, describes, searches, and calls only the
capabilities that its gateway rules could allow. A hidden capability is
indistinguishable from a nonexistent one.

**Mechanism: an optional adapter hook, not a core change.** The core's
`list` and `describe` stay principal-free (AE-ENG-01), so contract snapshots,
`validateMcpToolCatalog`, and tool-name collision detection still cover the
complete catalog. The adapters gain one optional, synchronous option:

```ts
type CapabilityVisibility = (args: {
  readonly principal: Principal | null;
  readonly capabilityId: string;
}) => boolean;
```

- `@invokta/mcp`: `createMcpHttpHandler`, `serveMcpHttp`, and
  `serveMcpStdio` accept `visibility`. MCP HTTP already creates one protocol
  server per request with the authenticated principal (`createMcpServer` in
  `http-protocol.ts`), so the `tools/list` handler in `protocol-server.ts`
  filters the frozen catalog, and `tools/call` answers a hidden tool with the
  same `Tool <name> not found` protocol error as an unknown tool, without
  calling `engine.invoke` or emitting an event. stdio evaluates visibility
  with the host-configured principal.
- `@invokta/http`: `GET /capabilities` returns only visible capabilities;
  `GET` and `POST /capabilities/{id}` answer a hidden ID with the same 404
  `CAPABILITY_NOT_FOUND` as an ID outside the catalog, before reading the
  body; `GET /openapi.json` is generated from the visible set and cached per
  distinct visible set.
- `@invokta/gateway` exports `gateway.visibility`, compiled from the rules:
  `public` is visible to every caller, `authenticated` to every non-null
  principal, `deny` to nobody, and `requireScopes` to principals holding the
  scopes. An access function may depend on input, which a listing does not
  have, so a rule with a custom function declares an explicit
  `visible?: (principal) => boolean`.

**Rules.**

- Visibility never grants access. A visible capability still passes its
  access rule on every call, and can still be `FORBIDDEN` for a particular
  input, for example a tenant mismatch.
- The predicate is synchronous and reads only the principal, so listing 200
  tools costs 200 predicate calls and no I/O.
- A throwing predicate hides the capability and logs one payload-free
  warning.
- MCP clients cache tool lists. A change to a caller's scopes appears the
  next time the client lists tools; stateless HTTP sends no
  `notifications/tools/list_changed` (AE-LIMIT-05).

**Acceptance criterion.** With the demo rules, `reader` lists only
`billing_get-invoice` and `support-agent` lists all three tools. `reader`
calling `billing_refund` receives a protocol error byte-identical to a call
of a nonexistent tool, and no engine event is emitted. The HTTP adapter
answers 404 for a hidden describe or invoke, and each principal's OpenAPI
document contains only its visible operations.

### C — Search-based discovery

**Goal.** A client sees a small, constant number of tools whatever the
catalog size, and discovers the rest on demand without losing per-tool
authorization.

**Shape.** `createDiscoveryCapabilities(gatewayEngine, options)` in
`@invokta/gateway` returns a capability map that the host serves as a
separate engine:

| Capability | Annotations | Contract |
| --- | --- | --- |
| `<prefix>.search-tools` | `readOnly` | Input `{ query, limit? }`: a query of 1 to 256 characters and 1 to 20 results, 8 by default. Output `{ tools, truncated }`: each entry has the ID, title, description, input and output schemas, annotations, and deprecation of one visible capability |
| `<prefix>.invoke-read-tool` | `readOnly` | Input `{ tool, arguments }`; accepts only targets annotated `readOnly: true` |
| `<prefix>.invoke-tool` | `destructive`, `openWorld` | Input `{ tool, arguments }`; accepts every other visible target |

Splitting invocation by risk class keeps client confirmation meaningful. A
client that asks before destructive tools asks before every `invoke-tool`
call and never before a read. A single generic tool would either prompt for
every read or never prompt for a deletion.

An optional `alwaysList` publishes a short list of capabilities directly,
next to the three discovery tools, so the most frequent ones keep their
typed contract (a hybrid catalog).

**Execution path.** The `invoke-*` handlers call the gateway engine's
`engine.invoke(target, arguments, …)` with the caller's principal, signal,
request ID, source, and progress sink. The target's gateway rule, input
validation (phase 1), upstream access, timeout, events, and authorization
decision apply exactly as for a direct call. The path stays single: outer
adapter, discovery engine `invoke`, gateway engine `invoke`, upstream.

**Errors.**

| Situation | Result |
| --- | --- |
| Unknown or hidden target | Declared domain error `TOOL_NOT_FOUND`, identical in both cases |
| Non-read-only target sent to `invoke-read-tool` | Declared domain error `TOOL_NOT_READ_ONLY` naming the tool |
| Target fails with a framework code (`INPUT_INVALID`, `FORBIDDEN`, `CANCELLED`, …) | The same code |
| Target raises a declared domain error | `TOOL_DOMAIN_ERROR` with `{ tool, code, retryable, details? }`, because ADR 0045 allows at most 64 declarations per capability |

**Ranking.** The default ranking is deterministic and lexical over ID
segments, titles, and descriptions. Its index is built once from the frozen
catalog: no network, no model. A host MAY inject a `rank` port, for example
embedding search, as `(query, candidates, { signal }) => Promise<string[]>`
with a finite timeout. Its result is intersected with the visible candidate
IDs, so a ranker can reorder or drop tools but never add one. Invokta
provides no embedding or retrieval abstraction (AE-LIMIT-03); the port and
its implementation are host-owned.

**Bounds and audit.** At most 20 results and a 64 KiB response budget:
results that would exceed it are dropped from the tail and `truncated` is
`true`; a schema is returned whole or not at all. A search is recorded with
the request ID, principal ID, and result count, never the query text, which
may contain sensitive data. Each invocation produces the target's normal
gateway decision.

**Where to serve it.** A host may publish the full, visibility-filtered
catalog at `/mcp` for clients with native tool search, and the discovery
engine at `/search/mcp` for clients without it. Both paths satisfy the
mount-path rule of ADR 0039.

**Costs.**

- `invoke-tool` is a generic execution entry point, the kind of
  infrastructure interface AE-INV-01 rejects as a domain action. It is
  published only by a gateway, never by an Action Engine, and every target
  remains a domain capability addressable by its own ID. The ADR must accept
  this explicitly.
- Three tools stand for N capabilities, which departs from "one capability,
  one tool" (AE-MCP-01) at the protocol surface.
- The `invoke-*` output is `{ result }` with a generic schema; typed
  `structuredContent` and rich content blocks of the target are not
  reproduced.
- Search then invoke adds a round trip and depends on the model searching
  well; `alwaysList` mitigates the most frequent cases.
- Tool descriptions reach the model through search results, as they do
  through `tools/list`; catalog pinning and the phase 4 lock file still
  apply.

**Acceptance criterion.** With a 200-tool fixture, a client lists exactly
three tools plus `alwaysList`. `search-tools` returns at most `limit`
visible tools with their schemas. `invoke-read-tool` with a destructive
target fails as `TOOL_NOT_READ_ONLY`. A hidden target and an unknown target
produce identical `TOOL_NOT_FOUND` errors. Every invocation produces the same
gateway decision and upstream result as a direct call of the target.

## Security model

| Threat | Control in the proof of concept |
| --- | --- |
| Anonymous access to a protected upstream | Adapter `authenticate` is required; default rule is `deny` |
| A typo removes a deny rule | Rules and include patterns must match at least one capability |
| An unavailable PDP grants access | Throwing or rejecting rules deny (`failed` outcome) |
| The gateway widens an upstream's policy | Upstream engines still enforce their own `access` |
| Tool poisoning or a silent catalog change | Catalog frozen at startup; optional pinned fingerprint |
| Confused deputy through token passthrough | Caller credentials never reach upstreams; service credentials per connection |
| An upstream hangs or floods | Finite tool timeout, bounded discovery, truncated error messages; the core enforces the lossless JSON model |
| Audit leaks payloads or secrets | `onDecision` carries IDs, rule name, and outcome only; failures in the sink are contained |
| Static key disclosure from configuration | Only SHA-256 digests are configured |

Planned controls for tool discovery (phases 2 and 3):

| Threat | Planned control |
| --- | --- |
| A caller enumerates capabilities it cannot use | Hidden capabilities are absent from `tools/list`, HTTP listing, OpenAPI, and search, and answer exactly like nonexistent ones |
| A generic invoke tool widens access | `invoke-*` calls the target through the gateway `engine.invoke`, so the target's rule, validation, and upstream access apply |
| A generic invoke tool bypasses client confirmation | Invocation is split into `invoke-read-tool` and a `destructive` `invoke-tool` |
| A ranker injects or reveals a tool | Ranker output is intersected with the caller's visible candidates |
| Search queries leak into audit logs | Searches record only IDs and the result count |

## Relationship to accepted contracts

| Contract | Proof of concept | Decision needed |
| --- | --- | --- |
| AE-ARCH-03 single path | Respected: adapters call only `engine.invoke`; proxies call upstream `engine.invoke` or `tools/call` | None |
| AE-ARCH-04 portability | Uses only Web globals (`crypto.subtle`, `structuredClone`) | Add the package to the portability test when promoted |
| AE-SCHEMA-02, AE-INV-02 validation | **Tension**: the gateway checks only that input and output are JSON objects; the upstream validates | Phase 1 adds a host-injected JSON Schema validator port |
| AE-LIMIT-02 no remote registry or discovery | **Tension**: MCP tools are listed over the network once, at the composition root, explicitly configured, and optionally pinned | Accept startup discovery as explicit composition, or require a committed catalog lock file |
| AE-LIMIT-04, scope matrix: no policy language | **Tension**: rules are a first-match routing table over capability IDs; decisions stay functions | Accept the routing table as configuration rather than a policy language |
| AE-SCOPE-01 package inventory | A fourteenth package, private for now | An ADR adds `@invokta/gateway` as an optional runtime helper |
| AE-INV-01 capability first; "a server that merely mirrors APIs is not an Action Engine" | The gateway is infrastructure, not an Action Engine; it republishes upstream domain IDs under a namespace | Document the gateway as a host composition, never as a domain engine |
| Maturity level E, federated platform | Out of scope: no registry, tenancy, rollout, control plane, or dynamic catalog | Keep explicit in the ADR |
| AE-OBS-01 single hook | `onDecision` is a gateway option, not an engine hook; engine events are unchanged | Decide whether decisions stay a gateway option or become an `onEvent` recipe |
| AE-ACCESS-01 published access kind | Every gateway capability publishes `access: "function"` | Accept, or publish the bound kind when the rule is `public` or `authenticated` |
| AE-ENG-01 `list` and `describe` | Unchanged; D filters in the adapters, not the core | None for the core |
| AE-MCP-01, AE-HTTP-01, AE-HTTP-02 adapter behavior | D adds an optional `visibility` option; a hidden capability answers like a nonexistent one | An ADR for the adapter option and its error equivalence |
| AE-INV-01, AE-MCP-01 for the discovery engine | C publishes three generic tools for N capabilities | Accept `invoke-*` as gateway-only infrastructure, or reject C |
| ADR 0045 declared domain errors | C wraps target domain errors as `TOOL_DOMAIN_ERROR` | Accept the wrapping |
| AE-LIMIT-03 no retrieval abstraction | C ranks lexically; semantic ranking only through a host-owned port | Confirm the port is not a retrieval abstraction |
| AE-LIMIT-05 no server-to-client notifications | Visibility changes appear on the client's next `tools/list` | None |

## Known limitations found by the proof of concept

- **Input errors from MCP upstreams arrive as `UPSTREAM_TOOL_ERROR`.** The
  demo shows an upstream Invokta engine's `INPUT_INVALID` wrapped as a domain
  error with the serialized upstream error as its message. The validator port
  of phase 1 rejects invalid input before the call, as `INPUT_INVALID`.
- **Rules that read `input` see unvalidated data.** Until the validator port
  exists, a rule must treat `input` as untrusted.
- **The catalog is not filtered per caller.** `engine.list()` has no principal,
  so every authenticated caller sees every published tool, including ones it
  cannot call. Phase 2 (option D) adds per-caller visibility.
- **Every caller receives the whole catalog.** 200 small tools already cost
  about 24,000 tokens in one `tools/list`. Phase 3 (option C) adds
  search-based discovery.
- **Rich MCP content is not reconstructed.** A proxied tool without an output
  schema returns `{ content }` as structured data; images and audio are not
  re-emitted as content blocks.
- **No upstream lifecycle.** A dropped stdio or HTTP connection fails calls
  with `EXECUTION_FAILED` until the host reconnects and restarts.
- **Request IDs are shared with engine upstreams** for correlation. Hosts
  that attach one `@invokta/otel` handler to both the gateway and an upstream
  engine must use separate handlers.

## Limits (proof of concept)

| Dimension | Limit |
| --- | --- |
| Upstream name and namespace | 1-64 lowercase letters, digits, or inner hyphens |
| Rule pattern | `*`, an exact ID, or `prefix.*` |
| MCP tools per upstream | 256 by default, at most 4,096 |
| MCP `tools/list` pages per upstream | 64 |
| MCP tool call timeout | 30,000 ms by default; 1 through 2,147,483,647 ms |
| Upstream tool error message | 1,024 characters |
| Presented API key | 1,024 characters |

## Delivery plan

Each phase is one cohesive, test-first deliverable with its own acceptance
criterion.

| Phase | Deliverable | Acceptance criterion |
| --- | --- | --- |
| 0 — Proof of concept | Private `packages/gateway`, tests, runnable demo, this note | Engine and MCP upstreams are served through MCP HTTP and HTTP JSON with chained authentication, first-match rules, default deny, decision audit, and pinned MCP catalogs; repository gates pass |
| 1 — Contract hardening | JSON Schema validator port injected by the host; ADR; package public API types test; architecture and portability tests; recipe and docs-site reference | Invalid input to any upstream fails as `INPUT_INVALID` before `run`; the ADR resolves every tension above |
| 2 — Per-caller visibility (D) | Optional `visibility` option in `@invokta/mcp` and `@invokta/http`; `gateway.visibility` compiled from the rules, with `visible` on custom function rules; ADR for the adapter change | The [D acceptance criterion](#d--per-caller-visibility) |
| 3 — Search-based discovery (C) | `createDiscoveryCapabilities` with `search-tools`, `invoke-read-tool`, `invoke-tool`, `alwaysList`, lexical ranking, and the optional `rank` port | The [C acceptance criterion](#c--search-based-discovery) |
| 4 — Catalog lock | `invokta gateway lock` in `@invokta/tooling`: write the MCP catalog snapshot and fingerprints to a committed file; the gateway verifies it at startup | A changed upstream tool fails startup and `yarn check` with a reviewable diff |
| 5 — Mounting router | Web-standard router that serves several MCP and HTTP handlers, each with its own mount path, authenticator, and Protected Resource Metadata | One origin serves `/e/<engine>/mcp` per engine and passes the installer's mounted-URL tests |
| 6 — Delegated credentials | Per-principal upstream credentials through the connector-broker `CredentialSource` port, including RFC 8693 token exchange | A user-subject upstream call receives a credential minted for that user and audience; a missing grant is a declared domain error |
| 7 — Operations | Recipes, not framework features: rate limits and quotas with `applyMiddleware`, upstream health and reconnection owned by the host, OpenTelemetry correlation across gateway and upstream engines | Each recipe is backed by an executable test |

Publishing `@invokta/gateway` requires phases 1, 2, and 4 and an accepted ADR.
Phase 3 may ship in the first release or later; it depends on phase 2.

## Open decisions

1. Is startup tool discovery acceptable, or must MCP catalogs always come from
   a committed lock file (phase 4)?
2. Should rules also match on upstream name or annotations, for example "deny
   every `destructive` capability unless the caller has `admin`"? The current
   design keeps one dimension, the capability ID, and leaves the rest to
   functions.
3. Visibility for a custom function rule without `visible`: visible to every
   authenticated caller, since listing grants nothing, or hidden, failing
   closed at the cost of hiding allowed tools?
4. Should visibility stay synchronous and principal-only, or accept an
   asynchronous, batched predicate backed by a PDP?
5. Is deterministic lexical ranking enough as the default for
   `search-tools`, with semantic ranking only through the host port?
6. Should the discovery engine keep two invoke tools split by risk class, or
   publish one `invoke-tool` annotated `destructive`?
7. Is `alwaysList` chosen by configuration only? Choosing it from usage data
   would move toward the platform scope of maturity level E.
8. Should an upstream Invokta engine's structured MCP error (`INPUT_INVALID`,
   `FORBIDDEN`) be mapped back to the same framework code, accepting that an
   upstream could choose the code the gateway reports?
9. Does the gateway ship as an optional runtime helper next to `auth-jwt` and
   `otel`, or as an official example until the evidence threshold is met?

## Proof-of-concept validation

- `yarn vitest run packages/gateway`: 39 tests covering engine and MCP
  upstreams, rule semantics, defaults, fail-closed rules, audit, domain error
  republication, progress, cancellation, timeouts, pinning, bounds,
  authentication methods, and an end-to-end path from an MCP client through
  the gateway to an authenticated upstream MCP server.
- `node packages/gateway/demo/serve.mjs` after `yarn build`: starts an
  upstream MCP engine that only the gateway's service token can reach and the
  gateway over MCP HTTP and HTTP JSON. Observed: 401 without a key, 403 for a
  missing scope or a deny-by-default capability, 422 for a republished domain
  error, 200 for allowed calls, 401 when calling the upstream directly without
  the service token, and one audit line per decision.
