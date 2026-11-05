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
`TextDecoder`, `structuredClone`) and import no `node:` module. Full portability
of the engine itself also depends on `@invokta/core`, whose Web-runtime
portability is ADR 0042's concern. The handler validates and snapshots its
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
capability key is addressable except keys that consist only of `.` or `..`,
which URL parsing removes as dot segments. Matching is exact and
case-sensitive on the parsed pathname; a trailing slash or extra segment is a
404, and the query string is ignored. Invocation uses source `http`, the
authenticated principal, and `request.signal`, so a client disconnect that the
runtime reports through that signal cancels the invocation.

The request body must use the `application/json` media type and is the
capability input. It is read incrementally as strict UTF-8 under a body limit
that defaults to 1,048,576 bytes; a declared `Content-Length` above the limit is
rejected before authentication, and a streamed body is rejected at the first
chunk that crosses it. A malformed body is rejected before `invoke`. A
well-formed non-object value reaches `invoke`, whose input contract rejects it
as `INPUT_INVALID`; the adapter adds no second validation rule.

### Boundary order and statuses

Each request is checked in this order: allowed host, allowed origin, route,
CORS preflight, method, declared body size, authentication, content type,
streamed body, JSON parsing, and then `engine.invoke`. Successful responses are
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

The adapter-only codes are a closed set exported as `HttpAdapterErrorCode`;
`HttpErrorCode` is their union with `EngineErrorCode`. An `EngineError` code
outside the seven-code taxonomy fails closed as the generic 500. Every response
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

The Web `Headers` interface joins repeated header lines into one value, so the
handler cannot see raw duplicates. The Node entry point described below rejects
a duplicated `Host` header; a joined `Authorization` value reaches the
authenticator, which must reject a credential it cannot parse.

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
and so on to later collisions in catalog order. A schema is copied verbatim
except for local `$ref` and `$dynamicRef` values in schema positions: `#` and
`#/...` resolve against the enclosing resource, which becomes the OpenAPI
document once the schema is embedded, so they are rebased onto the component.
Data keywords, every other reference form, and subschemas with their own `$id`
are not changed. Errors reference one shared `Error` schema; 401 also documents
`WWW-Authenticate`. When authentication is required, the document declares an
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
host); it accepts only an origin-form request target and exactly one `Host`
header, rejects user information or a target that changes the origin, and
otherwise answers 400 `INVALID_REQUEST`; it aborts the request signal when the
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
