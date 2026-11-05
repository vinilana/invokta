# ADR 0048: Plain HTTP JSON adapter with OpenAPI export

- Status: Accepted
- Date: 2026-11-05

## Context

An Action Engine reaches remote consumers only through MCP Streamable HTTP. A
remote application, an API gateway, or an automation that does not speak MCP
can reach the engine only in-process. Invokta can import an OpenAPI 3.1
contract into generated capabilities (ADR 0038), but it cannot publish an
OpenAPI description of an engine for those consumers.

AE-INV-04 requires the same capability to be invocable through every published
adapter without duplicating the handler, and AE-ARCH-03 requires every inbound
adapter to use `engine.invoke`. A plain HTTP JSON channel can satisfy both with
one route per capability over the existing pipeline. ADR 0007 and ADR 0024
already define the security posture of HTTP in Invokta: required pluggable
authentication with an explicit dangerous development mode, a Host allowlist,
Origin validation, bounded bodies, and sanitized errors.

Serverless and edge platforms (Deno, Bun, Cloudflare Workers, and Node through
a small bridge) share the Web `fetch` handler signature. A handler written
against `Request` and `Response` can be mounted by all of them and inside an
existing web framework without a framework dependency.

## Decision

Invokta adds a fourth framework runtime package, `@invokta/http`, depending
only on `@invokta/core`.

### Web-standard handler

The package root exports
`createHttpHandler(engine, options): (request: Request) => Promise<Response>`
and `createHttpOpenApiDocument(engine, options?)`. The package-root modules use
only Web-standard APIs (`Request`, `Response`, `Headers`, `URL`, streams,
`TextDecoder`, `structuredClone`) and import no `node:` module. Under ADR 0042
`@invokta/core` imports no Node.js built-in module either, so an engine and this
handler run on Fetch runtimes, just like `createMcpHttpHandler` from
`@invokta/mcp/web`. A test loads the handler on a simulated Web-standard host
with Node.js built-ins, `process.getBuiltinModule`, and code generation from
strings unavailable. Node.js is the runtime verified by tests; Deno, Bun,
Cloudflare Workers, and Vercel Edge are supported by design, as ADR 0042 states
for the core. `@invokta/http/node` remains a Node.js entry point. The handler
validates and snapshots its
configuration at construction, generates the OpenAPI document once, and never
rejects: an unexpected failure becomes a sanitized 500.

Routes are relative to `basePath`, which defaults to `/`. A configured base path
is an absolute path of unreserved ASCII segments without dot segments, empty
segments, percent encoding, a query, a fragment, or a trailing slash, at most
256 bytes:

| Route | Method | Result |
| --- | --- | --- |
| `{basePath}/capabilities` | `GET` | `{ "capabilities": engine.list() }` |
| `{basePath}/capabilities/{id}` | `GET` | `engine.describe(id)` |
| `{basePath}/capabilities/{id}` | `POST` | `engine.invoke(id, body)` output |
| `{basePath}/openapi.json` | `GET` | The generated OpenAPI 3.1 document |

`{id}` is exactly one percent-encoded path segment, decoded once, so any
capability key is addressable except `.` and `..`, which URL parsing removes as
dot segments. Handler and document construction reject an engine that has
either key with a `TypeError` rather than publish unreachable routes. Matching
is exact and case-sensitive on the parsed pathname; a trailing slash or extra
segment is a 404, and the query string is ignored.

The handler captures the capability IDs from `engine.list()` at construction;
the catalog is fixed by `createEngine`. After authentication, so the catalog is
not revealed to unauthenticated callers, and before the content type or body is
examined, an ID outside that set is answered with the same 404
`CAPABILITY_NOT_FOUND` body the engine reports. A caller-chosen string
therefore never reaches `engine.invoke`, so it never appears as the
`capabilityId` of an invocation event (AE-OBS-01) or in a bounded set that an
event consumer keeps, and no body is read for it. This matches the MCP adapter,
which resolves tool names against its catalog before invoking. Invocation of a
known ID uses source `http`, the authenticated principal, and `request.signal`,
so a client disconnect that the runtime reports through that signal cancels the
invocation.

The request body must use the `application/json` media type and is the
capability input. It is read incrementally as strict UTF-8 under a body limit
that defaults to 1,048,576 bytes; a declared `Content-Length` above the limit is
rejected before authentication, and a streamed body is rejected at the first
chunk that crosses it. A malformed body is rejected before `invoke`. A
well-formed non-object value reaches `invoke`, whose input contract rejects it
as `INPUT_INVALID`; the adapter adds no second validation rule.

### Boundary order and statuses

Each request is checked in this order: allowed host, allowed origin, route,
CORS preflight, method, declared body size, authentication, capability ID,
content type, streamed body, JSON parsing, and then `engine.invoke`. Successful responses are
`200` with the JSON result. Every error response has one shape:

```json
{"error":{"code":"...","message":"...","publicDetails":{}}}
```

`publicDetails` appears only when the `EngineError` carries it. Causes and
stacks never appear. Serialization is atomic like the MCP adapter's: an error
that is not a stable `EngineError`, or whose public fields cannot be serialized,
becomes the generic `EXECUTION_FAILED` 500 body.

| Status | Code |
| --- | --- |
| `400` | `INPUT_INVALID`, `INVALID_JSON`, `INVALID_REQUEST` |
| `401` | `UNAUTHENTICATED`, with `WWW-Authenticate: Bearer` |
| `403` | `FORBIDDEN`, `HOST_NOT_ALLOWED`, `ORIGIN_NOT_ALLOWED` |
| `404` | `CAPABILITY_NOT_FOUND`, `NOT_FOUND` |
| `405` | `METHOD_NOT_ALLOWED`, with `Allow` |
| `413` | `PAYLOAD_TOO_LARGE` |
| `415` | `UNSUPPORTED_MEDIA_TYPE` |
| `422` | `DOMAIN_ERROR` |
| `500` | `OUTPUT_INVALID`, `EXECUTION_FAILED`, `INTERNAL_ERROR` |
| `503` | `CANCELLED` |

`CANCELLED` maps to 503 Service Unavailable. The client cannot observe the
status for its own disconnect, so the code only reaches clients whose request
was stopped by a capability timeout, server shutdown, or dependency
cancellation: a server-side condition in which the request was not completed.
499 is a proxy-specific, non-standard code that generic clients do not
understand. 408 Request Timeout states that the client was too slow to send its
request, asks the connection to close, and some user agents retry it
automatically, which is unsafe for a non-idempotent invocation. 504 describes a
gateway's upstream timeout and does not cover shutdown. A 503 without
`Retry-After` makes no promise about when a retry could succeed.

`DOMAIN_ERROR` (ADR 0045) maps to 422 Unprocessable Content with the same body,
whose `publicDetails` is `{ code, retryable, details? }`. The request was
well-formed, authenticated, and authorized, its input satisfied the contract,
and the capability reported one of its declared domain outcomes. 400 stays
reserved for contract violations (`INPUT_INVALID`, malformed JSON), so a client
can tell a malformed request from a domain rejection. 409 Conflict and 404 Not
Found carry specific semantics that the adapter cannot infer from a domain
code, and a 5xx status would report a declared, expected outcome as a server
failure. The status does not vary with the domain code or `retryable`; clients
branch on `publicDetails.code` and read the retry hint from the body.

The adapter-only codes are a closed set exported as `HttpAdapterErrorCode`;
`HttpErrorCode` is their union with `EngineErrorCode`. The status table is
typed against `EngineErrorCode`, so a future framework code fails to compile
until it has a status, and a code outside the taxonomy fails closed as the
generic 500. Every response
carries `Content-Type: application/json` (except a preflight's empty 204),
`Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`.

### Security defaults

`auth` is required and is either
`{ mode: "required", authenticate(request) }` or
`{ mode: "dangerously-disabled-for-development" }`, as in ADR 0007. The
authentication request is `{ path, method, headers, signal }`, with a frozen
header view exposing only `get` and `has`. It is structurally identical to
`McpHttpAuthenticationRequest`, so one authenticator, including a provider
helper written against that shape, serves both adapters. `null` or a malformed
principal produces 401 with a Bearer challenge; a thrown authenticator produces
a sanitized 500. The principal is deep-cloned and validated before the body is
read. In required mode every route, including the OpenAPI document, needs
authentication; capability authorization stays in `engine.invoke`.

`allowedHosts` defaults to `127.0.0.1`, `localhost`, and `[::1]` and compares
the request URL's host name, ignoring the port. A deployment must list its
public host names, so an unconfigured deployed handler fails closed with 403.
CORS is off by default. Without `cors`, any request that carries an `Origin`
header is rejected with 403 before authentication, matching the MCP adapter's
Origin rule. `cors.allowedOrigins` is an explicit, non-empty list of exact
HTTP(S) origins; wildcards are rejected. An allowed origin is reflected in
`Access-Control-Allow-Origin` on every response with `Vary: Origin`; credentials
mode is not enabled. A preflight is an `OPTIONS` request with `Origin` and
`Access-Control-Request-Method` on an existing route; it is answered with 204
before authentication, listing the route's methods, `authorization`,
`content-type`, and any configured `cors.allowedHeaders`, plus
`Access-Control-Max-Age` only when `cors.maxAgeSeconds` is configured.

A Web `Request` exposes neither raw header lines nor the raw request target:
`Headers` joins repeated lines into one value, and `request.url` is already
normalized, so dot segments and percent-encoded dots have been resolved. The
Web handler therefore cannot detect those aliases. The Node entry point
described below rejects them, as MCP HTTP does. A host that mounts the handler
on another runtime behind a proxy that routes or denies by raw path must
normalize or reject such targets before the handler. On other runtimes, a
joined `Authorization` value reaches the authenticator, which must reject a
credential it cannot parse.

### OpenAPI export

`createHttpOpenApiDocument` builds an OpenAPI 3.1.0 document from
`engine.list()` and `engine.describe()` only, so it publishes nothing those
methods do not already publish. It sets `jsonSchemaDialect` to JSON Schema
2020-12, the draft the core requests from schema converters, and uses the base
path as its single relative server URL, so it names no host. Each capability has
one path, `/capabilities/{percent-encoded id}`, with a `describe.<id>` GET and an
`invoke.<id>` POST; the list route is `listCapabilities`. The POST uses the
capability title as its summary and the description as its description.

Input and output schemas become `#/components/schemas/<name>.Input` and
`<name>.Output`. `<name>` replaces each character outside `A-Z`, `a-z`, `0-9`,
`.`, `_`, and `-` with `_` (an empty key becomes `_`) and appends `-2`, `-3`,
and so on to later collisions in catalog order. A schema is copied verbatim,
with every member created as an own data property so a keyword or property
named `__proto__` survives, except for local `$ref` and `$dynamicRef` values
in schema positions. `#` and `#/...` resolve against the enclosing resource,
which becomes the OpenAPI document once the schema is embedded, so they are
rebased onto the component. Data keywords, every other reference form, and
subschemas whose non-fragment `$id` starts their own resource are not changed;
a fragment-only `$id` such as draft-07 `#plain` is an anchor and does not stop
rebasing.

Every component lives in the one OpenAPI document resource, so an identifier
that occurs twice there would be ambiguous. That happens when one schema with a
`$anchor`, `$dynamicAnchor`, fragment-only `$id`, or non-fragment `$id` is
published as both input and output, or by two capabilities. Generation, and
therefore handler construction, fails with a `TypeError` naming the capability,
the side, and the identifier, rather than publishing an ambiguous document.
Anchors scoped inside a subschema with its own `$id` are checked through that
`$id`. Engines whose schemas carry no such identifiers, which is the default
output of common converters, are unaffected. The MCP adapter embeds each schema
in its own tool definition and is not subject to this rule.

Errors reference one shared `Error` schema; 401 also documents
`WWW-Authenticate`. A capability that declares domain errors also gets a 422
response whose schema is a `oneOf` with one branch per declared code, in
declaration order. Each branch is titled with the code, carries its public
description, and fixes `error.code` to `DOMAIN_ERROR`,
`publicDetails.code` to the domain code, and `publicDetails.retryable` to its
hint. A declared details schema is embedded as
`#/components/schemas/<name>.Error.<CODE>` and referenced from
`publicDetails.details`, under the same rebasing and identifier rules as input
and output schemas. A capability without declarations has no 422 response,
because it cannot produce `DOMAIN_ERROR`. When authentication is required, the document declares an
HTTP Bearer security scheme matching the challenge; with authentication
disabled it declares none. Each call returns a new plain object that a host may
post-process, for example to describe another credential scheme, before
publishing it.

### Node entry point

The `@invokta/http/node` subpath exports
`serveHttp(engine, options): Promise<HttpServerHandle>`. It creates the
Web-standard handler from the same options and adds only Node translation: it
binds `127.0.0.1:3000` by default and requires `allowedHosts` for a
non-loopback bind (defaulting otherwise to the loopback names and the bind
host); it accepts only an origin-form request target whose path URL parsing
leaves unchanged, exactly one `Host` header without user information, and at
most one `Authorization` header, and answers anything else, including
`/x/../capabilities` and `/capabilities/%2e%2e/capabilities`, with 400
`INVALID_REQUEST`, so the path it serves is exactly the one a proxy saw; it aborts the request signal when the
client disconnects; it closes a connection whose body the handler did not
consume; and its `close()` is idempotent and aborts active requests. It adds no
route, limit, or status of its own and no web framework dependency.

### Core change

`ExecutionSource` gains `"http"`, so capabilities and events can distinguish
this channel. This is the only core change; it is additive for producers, and a
consumer that switches exhaustively over `ExecutionSource` must handle the new
member.

## Consequences

- A capability is reusable from non-MCP HTTP clients without a second
  implementation, and an engine can publish a standard machine-readable
  contract of its capabilities.
- Framework runtime packages become four and official inbound adapters become
  CLI, MCP, and plain HTTP JSON.
- The OpenAPI document is generated, not authored; it cannot describe
  per-capability security, rate limits, or examples that the engine does not
  publish.
- The adapter provides no TLS, proxy trust, rate limiting, concurrency limit,
  compression, streaming, or batch invocation; hosts own those controls.
- Adding the channel to the `create-invokta-engine` starter profiles, devtools
  adapter emulation, and the deploy toolkit requires separate decisions.
