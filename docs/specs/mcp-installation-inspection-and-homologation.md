# MCP installation inspection and homologation specification

Status: Accepted by ADR 0022 and extended by ADR 0023

Contract review verdict: **APPROVED**

## Summary

Invokta extends `@invokta/devtools` with two ways to validate an installed MCP
server without loading its workspace:

- `invokta-devtools` and `invokta-devtools open` start an idle loopback web
  workbench. The user explicitly connects one stdio or Streamable HTTP target,
  inspects its tools, and may make one manual tool call at a time.
- `invokta-devtools verify` performs a non-interactive initialization and full
  paginated `tools/list` validation. It never sends `tools/call`.

The existing `doctor <module>` and `serve <module>` commands retain their ADR
0020 contracts. `serve` remains the workspace-aware Invokta engine mode;
attached inspection treats the target only as an MCP server and makes no claim
about `engine.invoke` or its implementation.

`@invokta/mcp` encapsulates the approved official SDK behind a new plain-type
client facade. Devtools does not import SDK packages or expose SDK values.

The durable decisions are recorded in ADR 0022 and ADR 0023.

## Problem

The ADR 0021 dev server requires a built engine module. That is appropriate
while developing an Invokta engine, but it cannot homologate what an MCP client
will actually launch or reach when:

- the server is installed as a local stdio command outside the current
  workspace;
- the server is available only through a Streamable HTTP URL;
- authentication is injected by the installation environment; or
- CI must validate the protocol and tool catalog without executing a domain
  action.

The installed target may not be an Invokta engine. Therefore its internal
execution path, principals, Doctor checks, core events, and workspace state are
unknown and must not be inferred.

## Goals

- Start the devtools workbench without a module path or workspace load.
- Validate an explicit local stdio installation descriptor.
- Validate an explicit Streamable HTTP endpoint with no authentication, a
  bearer token, custom request headers, or an interactive ephemeral OAuth flow.
- Exercise only initialization and tool discovery during automated
  verification.
- Let a person make a single deliberate tool call from the workbench.
- Keep credentials ephemeral, masked, and absent from every response,
  diagnostic, activity record, and browser storage surface.
- Keep the official MCP SDK isolated in `@invokta/mcp`.
- Preserve the compact, readable, Postman-like Invokta workbench identity.

## Non-goals

- Discovering servers, scanning a workspace, reading MCP client configuration,
  or importing `invokta.mcp.json`.
- Proving that a separate MCP client configuration contains the descriptor.
- Persisting targets, credentials, catalogs, calls, results, or activity.
- Connecting more than one target or running more than one call concurrently.
- Automatic invocation, retry, replay, load testing, scheduling, or monitoring.
- Evals, judges, scoring, release gates, certification, or deployment approval.
- OAuth device flow, client credentials, private client secrets, provider-
  specific login, persistent login, or general secret management.
- MCP resources, prompts, sampling, elicitation, tasks, roots, stateful product
  sessions, or server-to-client requests.
- Editing a target, installation, client configuration, or project.
- Relaxing TLS verification, following redirects, or binding devtools outside
  loopback.

## Modes and command contract

```text
invokta-devtools [--port <number>]
invokta-devtools open [--port <number>]

invokta-devtools verify --stdio <executable>
  [--arg <value>]... [--cwd <directory>]
  [--env <child-name>=<source-environment-name>]...

invokta-devtools verify --http <url>
  [--auth <none|bearer|headers>]
  [--bearer-env <environment-name>]
  [--header-env <header-name>=<environment-name>]...

invokta-devtools doctor <esm-module> [--export <name>]
invokta-devtools serve <esm-module> [--export <name>] [--port <number>]
  [--engine-port <number>] [--watch --build <command>]
```

Bare invocation and `open` are exact aliases. `--port` follows the ADR 0021
range and defaults to `4100`; the server binds only `127.0.0.1`. Startup prints
the existing ready line:

```text
Invokta devtools listening on http://127.0.0.1:<port>/
```

The workbench starts in `idle`. Before an explicit connection request, it MUST
NOT resolve a module, read a workspace file, open an outbound connection, spawn
a process, or inspect environment values.

`verify` requires exactly one of `--stdio` and `--http`. `--arg`, `--cwd`, and
`--env` are valid only with `--stdio`. `--auth`, `--bearer-env`, and
`--header-env` are valid only with `--http`. Options other than `--arg`, `--env`,
and `--header-env` may appear at most once.

For stdio, each `--arg` is one exact argument and may be empty or begin with a
hyphen. `--env CHILD=SOURCE` reads `SOURCE` from the devtools process environment
and overlays its value as `CHILD` in the child environment. Names must match
`[A-Za-z_][A-Za-z0-9_]*`; a duplicate child name or a missing source value is
invalid usage. The executable and working directory are resolved only when
verification begins. The working directory defaults to the devtools current
working directory.

For HTTP, `--auth` defaults to `none`. `bearer` requires exactly one
`--bearer-env` and forbids `--header-env`. `headers` requires at least one
`--header-env HEADER=SOURCE` and forbids `--bearer-env`. `none` forbids both.
Environment values are read only after all arguments validate. Header names are
case-insensitively unique and must be valid HTTP field names. A missing source
environment value, an empty bearer value, or a header value containing CR or LF
is invalid usage. Literal credential values are never accepted in command-line
arguments. OAuth is intentionally unavailable to `verify`; it requires the
interactive workbench callback and cannot be selected by a CLI authentication
value.

Unknown commands, unknown options, extra positionals, invalid combinations,
missing values, and duplicate singular options are invalid usage. The existing
`doctor` and `serve` parsers and behavior are unchanged.

### Verify output and exits

Successful verification writes exactly one deterministic JSON object followed
by a newline to standard output and writes nothing to standard error:

```json
{
  "status": "ok",
  "transport": "stdio",
  "server": {
    "name": "example-server",
    "version": "1.0.0",
    "protocolVersion": "2025-11-25"
  },
  "pageCount": 1,
  "toolCount": 3
}
```

The object property order shown above is stable. The `transport` value is
`stdio` or `http`. Server-provided strings are JSON encoded and remain subject
to the response limits. No target descriptor, URL, command argument,
environment name or value, header, or credential is included.

Failures write one deterministic, stack-free line to standard error and no
standard output:

```text
invokta-devtools verify: <ERROR_CODE>: <safe message>.
```

| Exit | Meaning |
| ---: | --- |
| `0` | Initialization and complete tool-catalog validation succeeded |
| `1` | Spawn, connection, authentication, protocol, timeout, cancellation, or limit failure |
| `2` | Invalid usage, target descriptor, option combination, or required environment value |

Verification always requests client closure and waits for the public
`McpClientConnection.close()` promise before it resolves. A closure failure
after an otherwise successful verification exits `1`. For stdio, this is the
official SDK transport's public close semantic; verification does not add a
process supervisor or promise exact operating-system process-reap timing. It
sends only `initialize`, the required `notifications/initialized`, and
sequential `tools/list` requests. It does not send `tools/call`, retry a
request, or fall back to another transport.

## Target contracts

### Stdio target

A stdio target contains:

- one non-empty executable string;
- an ordered array of exact argument strings, defaulting to empty;
- an optional working directory, defaulting to the current working directory;
  and
- an environment overlay captured immediately before spawn.

The target is spawned directly with `shell: false`. The child receives only the
official SDK's reviewed safe default environment allowlist plus the explicit
overlay. It does not inherit the complete devtools process environment. The
overlay is the stdio server's configuration and may contain credentials; MCP
does not define a protocol authentication exchange for stdio. Devtools never
interprets an environment value as an identity or authorization result.

Protocol messages use child stdout and stdin. Child stderr is continuously
drained and discarded so it cannot block the process or leak configuration. It
is never interpreted as MCP, captured, rendered, copied to standard output, or
retained. Spawn and premature-exit diagnostics use only the stable generic
error codes below. Empty configured credential values are rejected.

The client configures the official stdio transport with a conservative
10,485,760-byte read buffer. Crossing that SDK buffer boundary is normalized as
`LIMIT_EXCEEDED` and closes the client. This is a defensive MCP input-buffer
ceiling, not a bound on operating-system pipe buffering or total child-process
memory.

Disconnect calls the idempotent public client close operation and waits for its
promise. That operation delegates stdio shutdown to the official SDK transport.
Invokta does not promise a particular signal, grace period, descendant-process
cleanup, forced termination, or exact operating-system process-reap timing. No
arbitrary process ID supplied by the user is accepted.

### Streamable HTTP target

The URL must be absolute and satisfy all of these rules before a network
request is made:

- the scheme is `https`; `http` is accepted only when the URL host is the
  literal IPv4 address `127.0.0.1` or literal IPv6 address `[::1]`;
- username and password are empty;
- query and fragment are empty;
- the hostname is not empty and the port, when present, is valid; and
- the path is preserved exactly, with `/` used only when the URL has no path.

`localhost`, another `127.0.0.0/8` address, and a DNS name that resolves to
loopback do not qualify for the HTTP exception. HTTPS may target public or
private addresses because the user explicitly selects the homologation target.

The HTTP client uses platform certificate and hostname verification. There is
no TLS bypass, custom CA, proxy, redirect-following, or scheme fallback option.
Every 3xx response fails as `CONNECTION_FAILED`. The transport, not the user,
owns `Host`, `Origin`, `Content-Length`, `Transfer-Encoding`, `Connection`,
`Upgrade`, `Cookie`, `Set-Cookie`, `Mcp-Session-Id`, `Sec-*`, and `Proxy-*`
headers; custom authentication cannot set them.

The transport may honor a server-issued `Mcp-Session-Id` for requests made by
the current connection and may terminate that session during `close`. It never
returns, persists, imports, or resumes the identifier. This transport detail
does not create a devtools product session or authorize server-to-client
requests.

Authentication has exactly one form:

- `none` adds no credential header;
- `bearer` adds exactly one `Authorization: Bearer <value>` header; or
- `headers` adds a case-insensitively unique set of explicit header fields,
  including a custom `Authorization` scheme when needed; or
- `oauth` begins the interactive Authorization Code with PKCE lifecycle below.

The target rejects duplicate header names, CR or LF in values, and a bearer
value containing HTTP whitespace at either end. Header and bearer values are
captured into connection-owned memory, never returned by inspection APIs, and
cleared when the connection closes.

### Interactive OAuth target

OAuth is a workbench-only authentication type for an HTTP target. Selecting it
adds no token, client secret, authorization-server URL, or provider-specific
field to the connection form. Connect uses the MCP resource URL to perform the
official RFC 9728 and authorization-server discovery flow. The client uses the
exact bound `http://127.0.0.1:<port>/oauth/callback` URL, identifies itself as a
public client, requests Authorization Code with PKCE, and registers through the
dynamic client registration endpoint advertised by the authorization server.
The current workbench OAuth mode therefore requires that endpoint; it does not
accept a preconfigured client identifier or client secret.

The OAuth client facade returns a validated authorization URL only to the
owning browser response. That URL must use HTTPS. When the selected MCP
resource itself uses the literal-loopback HTTP development exception, the
authorization server may also use literal `127.0.0.1` or `[::1]` HTTP. A remote
HTTPS resource cannot downgrade discovery, registration, authorization, or
token exchange to loopback HTTP. The authorization URL must not contain
credentials or a fragment and is limited to 8,192 encoded bytes. Browser
navigation to it is explicit and top-level; devtools never proxies or frames
its content.

Protected-resource, authorization-server, registration, authorization, and
token endpoints must use the exact origin of the explicit resource.
Cross-origin endpoints are rejected before a request or browser navigation.
Redirects are still rejected, the metadata issuer must exactly equal the
selected authorization-server identifier, and platform DNS, certificate, and
hostname validation remains enabled. Terminal protected-resource discovery
failures are latched and must not enter the SDK's legacy authorization-server
fallback.

Every attempt uses a 256-bit random base64url state bound to the active target
slot. OAuth preparation has a 15-second deadline. The authorization URL remains
usable for at most 300,000 milliseconds. The callback request target is limited
to 8,192 bytes and requires exactly one matching state plus either one nonempty
authorization code of at most 4,096 Unicode code points or one OAuth error. A
state is single-use whether the callback succeeds or fails.

Token exchange and MCP initialization share a 15-second completion deadline.
Successful initialization then receives the existing separate 15-second full
catalog deadline. The provider retains tokens, client registration information,
discovery state, state, and PKCE verifier only in target-owned process memory.
The material is cleared on success-to-disconnect, denial, malformed callback,
timeout, cancellation, connection failure, or process shutdown.

The initial MCP request may be repeated once after the user explicitly
authorizes. Once connected, an HTTP 401 or 403 closes the connection as
`AUTHENTICATION_FAILED`; devtools does not automatically refresh, up-scope, or
replay a tool call. Reauthorization requires another explicit Connect action.

## Plain MCP client facade

`@invokta/mcp` exports an Invokta-owned client facade with the following
conceptual public shape. Exact declarations must preserve these fields and
must not reference `@modelcontextprotocol/sdk` modules or types:

```ts
export type McpJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly McpJsonValue[]
  | { readonly [key: string]: McpJsonValue };

export type McpClientTarget =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: "http";
      readonly url: string;
      readonly authentication?:
        | { readonly type: "none" }
        | { readonly type: "bearer"; readonly token: string }
        | {
            readonly type: "headers";
            readonly headers: Readonly<Record<string, string>>;
          };
    };

export interface McpClientServerInfo {
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: string;
  readonly instructions?: string;
  readonly capabilities: Readonly<Record<string, McpJsonValue>>;
}

export interface McpClientTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, McpJsonValue>>;
  readonly outputSchema?: Readonly<Record<string, McpJsonValue>>;
  readonly annotations?: Readonly<Record<string, McpJsonValue>>;
}

export interface McpClientToolPage {
  readonly tools: readonly McpClientTool[];
  readonly nextCursor?: string;
}

export interface McpClientToolResult {
  readonly response: Readonly<Record<string, McpJsonValue>>;
}

export interface McpClientOperationOptions {
  readonly signal?: AbortSignal;
}

export interface McpClientConnection {
  readonly server: McpClientServerInfo;
  listTools(
    cursor?: string,
    options?: McpClientOperationOptions,
  ): Promise<McpClientToolPage>;
  callTool(
    name: string,
    argumentsValue?: Readonly<Record<string, McpJsonValue>>,
    options?: McpClientOperationOptions,
  ): Promise<McpClientToolResult>;
  close(): Promise<void>;
}

export function connectMcpClient(
  target: McpClientTarget,
  options?: McpClientOperationOptions,
): Promise<McpClientConnection>;

export interface McpOAuthClientTarget {
  readonly transport: "http";
  readonly url: string;
  readonly authentication: { readonly type: "oauth" };
}

export interface McpOAuthAuthorizationOptions {
  readonly redirectUrl: string;
  readonly state: string;
  readonly signal?: AbortSignal;
}

export interface McpOAuthAuthorization {
  readonly authorizationUrl: string;
  finish(
    authorizationCode: string,
    options?: McpClientOperationOptions,
  ): Promise<McpClientConnection>;
  close(): Promise<void>;
}

export function beginMcpOAuthAuthorization(
  target: McpOAuthClientTarget,
  options: McpOAuthAuthorizationOptions,
): Promise<McpOAuthAuthorization>;
```

`connectMcpClient` validates and snapshots its target, creates one transport,
performs `initialize`, sends `notifications/initialized`, and resolves only
after the handshake succeeds. `close` is idempotent. Closing or aborting a
connection settles every active operation and removes transport listeners.
`callTool` returns a plain JSON representation of the protocol result,
including `isError` when the server supplies it; a tool-level `isError` result
is not converted into a client transport error.

The facade uses the same approved SDK and protocol baseline as the server side.
It accepts only lossless JSON data: finite numbers, no cycles, no accessors, and
no unsupported values. It validates and snapshots caller-controlled records
before asynchronous work. Objects returned to callers contain no SDK instance
or mutable SDK-owned value.

The facade enforces the 10 MiB per-message and response boundary for both
transports and configures the official stdio transport's conservative read
buffer at the same 10 MiB boundary. Devtools owns the higher-level deadlines,
catalog aggregation, single-target rule, and Activity buffer. Public closure
delegates to the SDK transport and makes no stronger stdio child-lifecycle
guarantee than the SDK's public `close` operation.

`beginMcpOAuthAuthorization` uses only the approved SDK OAuth implementation.
It snapshots its target, redirect URL, state, dynamic registration result,
discovery state, verifier, and tokens. `finish` is single-use, and `close` is
idempotent before or after completion. No public value exposes an SDK type,
token, registration response, discovery document, or verifier.

## Client and devtools errors

The facade rejects with an Invokta-owned `McpClientError` whose enumerable and
serializable public data is exactly `code` and `message`. It exposes no SDK
error, response body, request, headers, command, environment, or URL field. Any
local stack or internal cause is non-enumerable and is never serialized by the
CLI, local API, diagnostics, or Activity.

| Code | Safe meaning |
| --- | --- |
| `INVALID_TARGET` | The structured target is invalid before I/O |
| `SPAWN_FAILED` | The stdio executable could not start |
| `CONNECTION_FAILED` | The transport could not establish or maintain the requested connection |
| `AUTHENTICATION_FAILED` | The HTTP target rejected the supplied credentials with 401 or 403 |
| `PROTOCOL_ERROR` | The peer returned an invalid or incompatible MCP exchange |
| `TIMEOUT` | The applicable operation deadline expired |
| `LIMIT_EXCEEDED` | A message, response, catalog, page, or tool bound was crossed |
| `CANCELLED` | The caller or disconnect cancelled the operation |

Devtools adds three local state codes without changing the facade:

| Code | Safe meaning |
| --- | --- |
| `TARGET_BUSY` | Another target is connecting, connected, or closing |
| `NOT_CONNECTED` | An operation requires a connected target |
| `ENVIRONMENT_VALUE_MISSING` | A named CLI environment value is absent |

Messages are concise English summaries and MUST NOT interpolate a target URL,
command, argument, working directory, header name or value, environment name or
value, tool arguments, response body, or SDK message. Internal causes may be
observed only by local debugging instrumentation that is not part of devtools
diagnostics or Activity.

For the local browser API, invalid descriptors return 400, failed CSRF or origin
checks return 403, state conflicts return 409, request or MCP size limits return
413, target authentication and connection failures return 502, an unavailable
browser-session slot returns 503, and deadlines return 504. Error bodies contain
only `{ "code": string, "message": string }`.

## Connection lifecycle

The workbench has one process-wide target slot and these observable states:

```text
idle -> connecting -> connected -> closing -> idle
                 -> authorizing -> connected
                    -> idle (sanitized connection failure)
```

An explicit Connect action atomically claims the idle slot. A second Connect
while the slot is not idle fails with `TARGET_BUSY`; it never replaces the
current target. The connection belongs to the browser session that created it,
although its credentials live only in server process memory. Another browser
session can inspect only the fact that the slot is busy and cannot list tools,
call, or disconnect it.

Connect performs initialization and complete sequential catalog traversal.
Initialization has a 15-second deadline. After it succeeds, the complete
paginated catalog has a separate 15-second deadline. Failure closes all target
resources and returns to idle while retaining only the sanitized validation
outcome. Success exposes the server identity and catalog without exposing the
target descriptor or credentials.

For OAuth, Connect first claims the same target slot and returns
`authorizing` plus the authorization URL after bounded discovery and
registration. The owning browser polls sanitized session state while the user
completes authorization. A successful callback performs token exchange,
initialization, and catalog validation before exposing `connected`. The owner
may cancel while authorizing; another browser observes only `busy`.

Disconnect cancels an active call, closes the client, clears the catalog and
credential memory, clears Activity, and returns to idle. Process shutdown does
the same cleanup. A browser refresh does not persist or retransmit credentials;
the session may still disconnect its process-owned target after reload.

Only a connected session may send `tools/call`. The call requires a tool name
from the current catalog and an object argument, and begins only after an
explicit user action. One call may be active. Another call returns
`TARGET_BUSY`. A call has a 60-second deadline, is never retried, and its result
is returned only to the initiating browser response. The result is not retained
in Activity or any server-side history.

## Catalog, pagination, and bounds

Byte, page, and tool boundaries are inclusive: exactly the configured boundary
is accepted, and the next unit crosses the limit. An unsettled operation times
out when its deadline reaches exactly 15,000 or 60,000 milliseconds; it must
settle before that instant. Activity is a ring buffer: the 501st record drops
the oldest record instead of failing the current operation. Activity tool names
longer than 256 Unicode code points are truncated to the first 256 code points.

| Surface | Limit |
| --- | ---: |
| Initialization deadline | 15 seconds |
| OAuth preparation deadline | 15 seconds |
| OAuth user authorization deadline | 5 minutes |
| OAuth completion and initialization deadline | 15 seconds |
| OAuth authorization URL | 8,192 encoded bytes |
| OAuth callback request target | 8,192 bytes |
| OAuth authorization code | 4,096 Unicode code points |
| Complete catalog deadline | 15 seconds |
| Manual call deadline | 60 seconds |
| One encoded MCP message | 10,485,760 bytes |
| One call response | 10,485,760 bytes |
| Complete serialized catalog | 10,485,760 bytes |
| Catalog pages | 100 |
| Catalog tools | 2,000 |
| Activity metadata records | 500 |
| Activity tool-name display | 256 Unicode code points |
| Browser sessions retained in process memory | 128 |

Catalog pages are requested one at a time using exactly the previous page's
`nextCursor`. A missing cursor ends traversal. An empty cursor is a valid cursor
when supplied by the server. Repeated cursors, more than 100 pages, more than
2,000 accumulated tools, a duplicate tool name, or an aggregate catalog larger
than 10 MiB fails as `LIMIT_EXCEEDED` or `PROTOCOL_ERROR` as applicable and
closes the connection. Tool order is the server's page order.

Byte limits are measured on encoded transport bytes before JSON decoding. The
catalog aggregate is measured as compact UTF-8 JSON after conversion to the
plain facade types. A response that cannot be represented as lossless JSON is a
`PROTOCOL_ERROR`.

Activity is a process-memory ring buffer of metadata only. At capacity, adding
a record drops the oldest record. A record contains an opaque sequence number,
operation (`initialize`, `tools/list`, `tools/call`, or `disconnect`), start
time, duration, outcome, and optional safe error code or tool name. It contains
no URL, command, argument, working directory, header, environment data, request
arguments, response body, protocol body, SDK error, or target credential. A
server-provided tool name is truncated to its first 256 Unicode code points
before Activity stores or renders it; truncation never splits a surrogate pair.

## Workbench interface and local API

The idle and attached workbench is a compact desktop developer tool rather than
a landing page. It preserves the Invokta prompt mark, blue and neutral palette,
typographic role separation, one-pixel geometry, restrained status color, and
subtle background rails. Decorative bracket labels are prohibited because they
reduce scanability in dense tool views.

The idle view leads with Connection and presents mutually exclusive `stdio` and
`HTTP` forms. The stdio form uses separate command, repeatable argument,
working-directory, and environment rows; it never accepts a shell command
string. The HTTP form uses a URL field and explicit None, Bearer, OAuth, or
Custom headers authentication. Secret inputs use password controls and
accessible labels that identify their purpose without including their values.
After a connection response, the browser clears each value and replaces the
field with a masked configured state.

The attached navigation contains exactly these primary views:

- **Tools:** searchable tool catalog, selected input schema, JSON arguments,
  explicit Invoke action, and the current result;
- **Activity:** bounded protocol-operation metadata with status and duration;
  and
- **Connection:** sanitized server identity, transport kind, validation result,
  catalog counts, and Disconnect.

It does not show Capabilities, Test identities, Doctor, workspace watch, engine
events, or an engine trace. Copy uses MCP `tool` and `server` terminology and
never implies that an attached server is an Invokta engine.

The loopback interface provides these local routes:

| Route | Behavior |
| --- | --- |
| `GET /` and `GET /assets/*` | Static workbench bundle |
| `GET /api/session` | Session-bound CSRF token and sanitized target state |
| `POST /api/connection` | Validate and connect one explicit target |
| `DELETE /api/connection` | Close the session-owned target and clear its data |
| `GET /oauth/callback` | Consume one state-bound OAuth result and redirect to a clean result URL |
| `GET /oauth/result/*` | Show a static, query-free OAuth outcome |
| `GET /api/tools` | Plain catalog for the connected owning session |
| `POST /api/tools/call` | Perform one explicit call and return its current result |
| `GET /api/activity` | Return bounded metadata for the owning session |

Connection requests may contain credential values because the server must use
them, but no response echoes them. Server-provided catalog and explicit call
results may themselves be sensitive application data; they are returned only
to the owning loopback browser session and are never persisted. This does not
weaken the prohibition on returning target authentication or stdio environment
secrets.

## Browser and outbound security

Every interface request requires exactly one raw `Host` header equal to the
bound loopback authority. Forwarded host headers are ignored. Every POST and
DELETE requires an `Origin` exactly equal to the interface origin; a missing,
duplicate, malformed, or foreign Origin fails before body parsing.

`GET /api/session` creates a cryptographically random browser session in
process memory, sets an `HttpOnly; SameSite=Strict` session cookie without a
persistent expiration, and returns a distinct CSRF token bound to that session.
JavaScript retains that token in memory only. Every POST and DELETE requires the
cookie and one exact `X-Invokta-CSRF` header matching the bound token. Tokens are
rotated after a successful connection mutation and invalidated at process exit.
The successful mutation response carries the replacement token only in its
`X-Invokta-CSRF` response header, and JavaScript replaces the previous in-memory
value. The CSRF token is a local anti-forgery value, not a target credential,
and is never written to browser storage.

The process retains at most 128 browser sessions in insertion order. Before
creating a 129th session it evicts the oldest-created session that does not own
the active target; the connecting, authorizing, connected, or closing target
owner is never selected. An evicted cookie and CSRF token immediately stop authorizing local
API access, and a later `GET /api/session` creates a fresh session. If no session
is safely evictable, creation fails with HTTP 503 and
`SESSION_LIMIT_EXCEEDED`. Sessions and their ordering are never persisted.

The interface emits no `Access-Control-*` header and applies this minimum
Content Security Policy to HTML:

```text
default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'; object-src 'none'
```

It also sends `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
and denies framing. Static assets contain no inline executable code and make no
third-party request.

Connection descriptor bodies are limited to 1 MiB; tool-call API bodies use the
10 MiB MCP message limit. Requests crossing the applicable limit are rejected
before a target operation. Local API bodies require exact JSON content type and
strict UTF-8. Validation snapshots the descriptor before any asynchronous work.

The OAuth callback route is the only local route that accepts a query. It still
requires the exact bound Host and security headers, emits no CORS header, and
never reflects its query. It does not require the browser-session cookie because
the external redirect may omit a `SameSite=Strict` cookie. Its 256-bit,
single-use state is the callback authority. The callback response contains no
authorization code, state, token, provider error text, or target URL. A callback
with exactly one valid state consumes the attempt even when its code or error
fields are malformed. An oversized request target or an ambiguous state does
not select an attempt. Only the canonical origin-form `/oauth/callback` target
with an optional query is routed; absolute-form and normalized path aliases are
rejected. After processing, the server redirects to a static `/oauth/result/*`
path so callback material does not remain in the visible address or result page
URL.

## Requirements

### AE-MCP-CLIENT-01: Isolated plain client facade

`@invokta/mcp` MUST encapsulate official SDK client transports behind the
plain-type facade above. No public declaration, runtime value, error, or result
may expose an SDK module or type. The core MUST NOT depend on the client facade.

### AE-MCP-CLIENT-02: Exact target and transport boundaries

The facade MUST validate and snapshot exactly one structured stdio or HTTP
target before I/O. Stdio MUST use `shell: false`; HTTP MUST enforce canonical
secure URL, header, redirect, and TLS rules. Closure MUST be idempotent and
settle active operations through the SDK's public transport close operation.
The contract MUST NOT claim a stronger stdio child-reap or signaling guarantee.

### AE-MCP-CLIENT-03: Bounded protocol operations

The facade MUST perform initialization, paginated tool listing, and explicit
tool calls through the approved SDK while enforcing the per-message boundary.
Cancellation MUST reach only the current operation. A protocol result marked
`isError` MUST remain a result rather than becoming a transport error.

### AE-DEVTOOLS-ATTACH-01: Inert zero-argument workbench

Bare invocation and `open` MUST start the same idle loopback interface without
a module path. Before explicit connection, the process MUST NOT load a
workspace, access a target, spawn a process, inspect credential environment
values, or discover configuration.

### AE-DEVTOOLS-ATTACH-02: Compatible engine mode

`doctor <module>` and `serve <module>` MUST preserve ADR 0021 behavior. Only
`serve` may expose engine Doctor, principals, workspace watch, core trace, or
claim the `engine.invoke` path. Attached mode MUST use MCP server terminology.

### AE-DEVTOOLS-ATTACH-03: Read-only verification

`verify` MUST initialize exactly one explicit target and traverse `tools/list`
sequentially to completion. It MUST NOT send `tools/call`, retry, discover,
persist, or mutate an installation. Output, diagnostics, and exit codes MUST
follow this specification.

### AE-DEVTOOLS-ATTACH-04: Explicit single-target lifecycle

The workbench MUST connect only after a same-session user action, hold at most
one target, run at most one manually requested call, and clean up target
resources on failure, disconnect, and shutdown. It MUST NOT replace a connected
target implicitly.

### AE-DEVTOOLS-ATTACH-05: Authentication and secret containment

CLI credential material MUST come from named environment variables. UI
credential material MUST remain only in browser and process memory and be
masked after entry. Target credentials and stdio environment values MUST NOT
appear in browser storage, API responses, diagnostics, Activity, trace data, or
verification output.

### AE-DEVTOOLS-ATTACH-06: Deadlines and limits

Initialization, catalog collection, manual calls, messages, responses, pages,
tools, and Activity MUST enforce the exact limits above. Reaching a deadline or
crossing a byte, page, or tool limit MUST fail closed without retry and release
the affected connection. Activity MUST drop its oldest record before adding a
record beyond capacity and MUST truncate stored tool names to 256 Unicode code
points without splitting a surrogate pair.

### AE-DEVTOOLS-ATTACH-07: Loopback browser isolation

The workbench MUST bind only loopback, validate exact Host and Origin, require a
session-bound CSRF cookie and header for every mutation, emit no CORS headers,
apply the specified CSP and security headers, and prevent one browser session
from controlling another session's target. It MUST retain at most 128
process-memory browser sessions and evict only the oldest-created session that
does not own the active target when capacity is needed.

### AE-DEVTOOLS-ATTACH-08: Compact mode-specific interface

Attached mode MUST expose Tools, Activity, and Connection validation in a
compact, keyboard-readable developer-tool layout. It MUST preserve the Invokta
identity, omit decorative bracket labels, identify secret fields accessibly
without revealing values, and omit workspace-only surfaces.

### AE-DEVTOOLS-ATTACH-09: Closed homologation scope

Attached inspection MUST NOT implement persistence, configuration import,
target discovery, multiple targets, OAuth grants other than the ADR 0023
ephemeral Authorization Code with PKCE flow, resources, prompts, automatic
calls, connected tool-call retries, evals, judging, certification, release
gating, or project and client configuration writes.

### AE-DEVTOOLS-ATTACH-10: Ephemeral OAuth authorization

OAuth MUST be initiated by the owning browser for one explicit HTTP target and
implemented by the isolated official SDK. State, callback, discovery, token
exchange, deadlines, cleanup, non-persistence, and no-replay behavior MUST
follow this specification. OAuth MUST NOT be accepted by `verify` or expose a
client secret, token, verifier, code, registration response, or discovery
document through a public surface.

## Acceptance matrix

| ID | Requirement | Contract test and evidence |
| --- | --- | --- |
| AC-MCP-CLIENT-01 | MCP-CLIENT-01 | Public API type tests import the facade without an SDK dependency and prove no emitted declaration references `@modelcontextprotocol/sdk`. |
| AC-MCP-CLIENT-02 | MCP-CLIENT-02 | A fixture stdio process receives the exact command arguments, only the safe default environment allowlist plus explicit overlay, and `shell: false`; invalid descriptors fail before spawn. |
| AC-MCP-CLIENT-03 | MCP-CLIENT-02 | HTTP boundary tests reject credentials, query, fragment, non-loopback HTTP, redirects, duplicate or forbidden headers, and CR/LF before protocol dispatch while accepting HTTPS and literal loopback HTTP. |
| AC-MCP-CLIENT-04 | MCP-CLIENT-02, MCP-CLIENT-03 | Official client/server fixtures cover initialize, one-page and multi-page tool lists, empty cursors, manual tool success, `isError`, cancellation, idempotent public close over both transports, and the conservative 10 MiB stdio SDK read buffer without asserting private child-process signals or reap timing. |
| AC-ATTACH-01 | DEVTOOLS-ATTACH-01 | Instrumented seams prove bare and `open` startup perform no module load, workspace read, outbound request, spawn, discovery, or credential lookup before Connect. |
| AC-ATTACH-02 | DEVTOOLS-ATTACH-02 | Existing ADR 0021 doctor, serve, authenticated invocation, principal, trace, and watch suites pass unchanged; attached route tests expose none of those claims. |
| AC-ATTACH-03 | DEVTOOLS-ATTACH-03 | Stdio and HTTP verification fixtures observe initialize and every `tools/list` cursor, observe zero `tools/call` requests, and assert exact stdout, stderr, cleanup, and `0/1/2` exits. |
| AC-ATTACH-04 | DEVTOOLS-ATTACH-04 | Lifecycle tests cover idle, connecting, connected, failure cleanup, disconnect, shutdown, a rejected second target, a rejected concurrent call, and no implicit retry. |
| AC-ATTACH-05 | DEVTOOLS-ATTACH-05 | Canary secrets supplied through every CLI and UI credential surface are absent from stdout, stderr, errors, API responses, browser storage, Activity, traces, and snapshots after disconnect. |
| AC-ATTACH-06 | DEVTOOLS-ATTACH-06 | Fake clocks prove unresolved initialization and catalog work fail at 15,000 ms and an unresolved call fails at 60,000 ms. Byte and count fixtures accept exactly 10 MiB, 100 pages, 2,000 tools, and 500 Activity records; they reject the first byte, page, or tool beyond its boundary, prove the 501st Activity record drops the oldest, and prove Activity truncates at 256 Unicode code points without splitting a surrogate pair. |
| AC-ATTACH-07 | DEVTOOLS-ATTACH-06 | Pagination tests reject repeated cursors, duplicate tool names, oversized aggregate catalogs, invalid JSON values, and an oversized call result while closing the target. |
| AC-ATTACH-08 | DEVTOOLS-ATTACH-07 | Raw HTTP tests cover missing, duplicate, malformed, and foreign Host/Origin, missing or stale cookie/CSRF pairs, cross-session control, no CORS headers, CSP, body limits, strict JSON UTF-8, the 128-session cap, eviction of the oldest non-owning session, and preservation of the active target owner. |
| AC-ATTACH-09 | DEVTOOLS-ATTACH-08 | Browser behavior and accessibility tests prove compact Tools/Activity/Connection navigation, explicit masked auth, keyboard operation, readable focus, no bracket labels, and no workspace-only controls. |
| AC-ATTACH-10 | DEVTOOLS-ATTACH-09 | Import-graph, filesystem, network, and process-spawn spies prove there is no target discovery, configuration import, persistence, unsupported OAuth grant, resource or prompt request, eval, release gate, or project/client write. |
| AC-ATTACH-11 | DEVTOOLS-ATTACH-10 | Official OAuth and fake-clock fixtures cover discovery, dynamic registration, exact issuer and same-origin endpoint validation, PKCE state, callback success, denial and clean result redirects, 15-second preparation/completion and 5-minute user deadlines, single use, inclusive URL/request/code bounds, terminal protected-resource discovery failures without legacy fallback, cancellation and late-result cleanup, one-attempt token/registration errors, no secret output or storage, and no post-connect refresh or tool-call replay. |
| AC-ATTACH-12 | MCP-CLIENT-01..03, DEVTOOLS-ATTACH-01..10 | Typecheck, lint, formatting, unit and integration tests, build, coverage, packed-tarball inspection, and isolated consumer smoke tests pass for both packages. |

## Compatibility and migration

`doctor <module>` and `serve <module>` remain source- and behavior-compatible.
The `@invokta/mcp` server APIs and existing imports remain compatible; both the
client facade and its OAuth authorization handle are additive and do not alter
the server adapter path to `engine.invoke`. Existing none, bearer, header,
stdio, `verify`, doctor, and serve invocations retain their meaning.

Bare `invokta-devtools` previously produced invalid usage because a command was
required. It now starts the idle workbench. This intentional command-line
behavior change must be called out in release notes. Scripts that require
invalid-usage detection must use an explicit unknown command in their negative
fixture. No existing valid command changes meaning.

The term installation validation means that devtools successfully used the
explicit descriptor to launch or connect, completed MCP initialization, and
read the complete tool catalog within the stated limits. It does not validate
or mutate any external MCP client configuration file.

## Contract review verdict

**APPROVED**

The specification defines the complete public surface, compatibility decision,
security boundary, success and failure behavior, lifecycle, deadlines, byte and
count limits, scope exclusions, and executable acceptance evidence required by
ADRs 0021 and 0022. Implementation remains subject to RED, GREEN, REFACTOR and one
validated cohesive commit per deliverable.
