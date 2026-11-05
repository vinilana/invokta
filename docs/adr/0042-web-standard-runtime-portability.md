# ADR 0042: Web-standard runtime portability for core and MCP HTTP

- Status: Accepted
- Date: 2026-11-05

## Context

Invokta engines ran only on Node.js, and only behind an HTTP server that
Invokta owned. `@invokta/core` imported `node:crypto` for request IDs,
`node:perf_hooks` for durations, and `node:util` for `types.isProxy` and
`types.isPromise`. Everything else in the core already used ECMAScript and Web
platform globals. `serveMcpHttp` created its own `node:http` server, and ADR
0039 left "a fetch-handler adapter for serverless platforms" to a separate
decision. An engine therefore could not be mounted in Hono, in Express or
Fastify through a Fetch adapter, or in a Next.js route handler, and could not
run on Cloudflare Workers, Deno, Bun, or Vercel Edge.

`crypto.randomUUID()` and `performance.now()` are Web globals. Type
introspection is not: ECMAScript deliberately offers no way to recognize a
proxy without running its traps, or a native promise without reading
user-controlled properties. ADR 0002, ADR 0003, and ADR 0037 rely on that
introspection to reject proxies at defensive boundaries without invoking them.

## Decision

### Core

`@invokta/core` imports no Node.js built-in module. It compiles against the
ES2024 and DOM declarations without Node.js types, so a Node.js global cannot
enter its source unnoticed, and an architecture test fails if a `node:` or bare
built-in specifier appears in `packages/core/src`. Request IDs come from
`globalThis.crypto.randomUUID()` and durations from
`globalThis.performance.now()`.

When the core module is evaluated, it reads `util.types.isProxy` and
`util.types.isPromise` once through
`globalThis.process.getBuiltinModule("node:util")`. Node.js 22.3 and later,
which includes every supported Node.js version, Deno, and Bun expose this
function. On those hosts the defensive behavior is unchanged: proxies and
promises are recognized without running user code, and later replacement of
the global cannot change the captured guards.

Where `process.getBuiltinModule` is unavailable, such as a Web-only isolate,
the core uses a documented portable fallback:

- proxy detection reports `false`, and promise detection uses
  `instanceof Promise`;
- every value checked against the lossless JSON data model of ADR 0002 is
  structured-cloned after its structural walk. The HTML structured-serialize
  algorithm throws for every proxy in the graph, so a proxied validated input,
  validated output, JSON Schema document, annotation, or connector
  configuration is still rejected with the same `INPUT_INVALID`,
  `OUTPUT_INVALID`, or construction `TypeError` as on Node.js. Accessors are
  still rejected before they are invoked, so the clone reads only data
  properties;
- at the remaining boundaries, which receive capability, connector, and
  composition definitions, Standard Schema contract objects, validator results,
  thrown `EngineError` values, and `AbortSignal` instances, a proxy's traps may
  run during the structural checks. A proxy that forwards to an acceptable
  object may be treated as that object. An `AbortSignal` must still pass the
  platform brand check performed with the captured `aborted` getter.

The fallback is not fail-closed because no portable check can distinguish a
proxy from an ordinary object, and rejecting every object would make the
engine unusable. A structured-clone probe cannot replace introspection outside
JSON values because definitions, schemas, and errors legitimately contain
functions. The narrowed checks receive values from the engine's own process:
its composition root, schema library, and capability code. Request data decoded
from JSON never contains a proxy, so the fallback reduces defense in depth
without widening the network boundary. A host that adds
`process.getBuiltinModule`, for example through a Node.js compatibility mode,
receives the full checks automatically.

### MCP HTTP

There is one HTTP protocol implementation. It validates and snapshots the
configuration, and then decides, for each request, the Host and Origin
allowlists, the canonical mount path, the method, the declared and streamed
body bounds, authentication and the principal snapshot, the media types, strict
UTF-8, and the one-message JSON-RPC rule, exactly as ADR 0007 and ADR 0039
define them. It dispatches each accepted request to a fresh protocol server and
transport with `source: "mcp-http"`, so every tool call still goes through
`engine.invoke`. A host adapter describes a request to it through a small set of
facts: method, request target, the authorities the request names, headers,
whether a header field was repeated, the body stream, and a cancellation
signal. The implementation returns a Fetch `Response` and whether the request
body was left unconsumed.

`@invokta/mcp/web` is a new portable entry point that imports no Node.js
built-in module. It exports `createMcpHttpHandler(engine, options)`, which
returns `(request: Request) => Promise<Response>`. The package root exports the
same function for Node.js hosts. Its options are `path`, `allowedHosts`,
`allowedOrigins`, `maxRequestBodyBytes`, and `auth`, with the same validation as
`serveMcpHttp`; `ServeMcpHttpOptions` extends them with `host` and `port`.
Configuration fails synchronously with a `TypeError`, and the handler never
rejects: a request it cannot read produces a sanitized HTTP 500.

The Fetch API changes what a handler can observe, so the handler maps each
`serveMcpHttp` guarantee to a Fetch request as follows:

- **Authority.** The `Host` header, when present, and the request URL's
  authority must each name an allowed host. Without `allowedHosts`, only
  `127.0.0.1`, `localhost`, and `[::1]` are allowed, so a deployed handler fails
  closed until it lists its public host names. Forwarded-host headers are
  ignored.
- **Target.** The path, query, and fragment of `request.url` must equal the
  mount path. A query, including an empty one, a fragment, and percent encoding
  are rejected. The host's URL parser has already resolved dot segments, so the
  handler routes the normalized path that the host itself routes.
- **Repeated fields.** Fetch joins repeated header fields with `, `. A comma in
  `Host` or `Content-Type`, neither of which can legitimately contain one, is
  treated as a repeated field and rejected. A joined `Authorization` value
  cannot be distinguished from one credential with parameters, so it reaches
  the authenticator as one value; a Bearer authenticator rejects it because a
  token cannot contain a comma or a space. `serveMcpHttp` keeps rejecting
  repeated raw `Authorization`, `Host`, and `Content-Type` fields.
- **Body.** The handler reads `request.body` incrementally, counts bytes,
  decodes strict UTF-8, and cancels the stream as soon as the limit is crossed
  or a sequence is malformed, so it holds at most one chunk beyond the limit. A
  declared `Content-Length` above the limit is rejected before
  authentication when the host exposes it.
- **Cancellation and connections.** `request.signal` reaches the
  authentication hook and the invocation. The host owns connections and their
  lifetime: the handler sets no hop-by-hop header and has no `close` method.

`serveMcpHttp` becomes a Node.js adapter over the same implementation. It owns
the `node:http` listener, supplies the raw facts Node.js exposes (raw header
counts and the raw request target, so dot-segment and absolute-form aliases
remain rejected), and exposes the request body as a pull-based stream that
attaches listeners on the first read and pauses after every chunk. It writes
the returned response, closes and drains the connection when the body was not
consumed, and aborts active requests on `close()`. Its public types and its
existing tests are unchanged.

The approved SDK 1.32.2 provides `WebStandardStreamableHTTPServerTransport`;
its Node.js `StreamableHTTPServerTransport` is a wrapper around it. The adapter
already used the Web-standard transport and continues to use it through the
isolated SDK boundary of ADR 0006, with `parsedBody` supplied after the
boundary checks. The transport's own Host, Origin, and body-size options are
not used because the boundary enforces them first. The portable entry point
reaches only the SDK's `server/index.js`, `server/webStandardStreamableHttp.js`,
`shared/auth.js`, `shared/transport.js`, and `types.js` modules. The SDK's RFC
9728 URL helper lives in its Express-bound authorization router, which imports
`express` and `node:crypto`, so the boundary derives the same path-suffix URL
itself.

ADR 0025 requires a synchronous SHA-256 digest for long tool names, and Web
Crypto offers only an asynchronous digest. `@invokta/mcp` therefore carries a
small FIPS 180-4 implementation whose output matches `node:crypto`, so every
published tool name is unchanged. The falsy request-ID sentinels of ADR 0006
use `globalThis.crypto.randomUUID()`.

### Verified and supported runtimes

Node.js is the runtime verified by tests, on the supported versions declared in
each package's `engines` field. The tests also run the portable entry point in a
Node.js child process where every built-in module is unavailable to `import`
and `require`, `process.getBuiltinModule` is removed, and code generation from
strings is disallowed, approximating a Web-only isolate.

The core and `@invokta/mcp/web` are supported by design on runtimes that provide
ES2024, the Fetch API, Web Streams, `TextEncoder` and a fatal `TextDecoder`,
`URL`, `AbortController` with `AbortSignal.any`, `structuredClone`,
`crypto.randomUUID`, and `performance.now`. These include Deno, Bun, Cloudflare
Workers, Vercel Edge, and Node.js frameworks such as Hono, Next.js route
handlers, and Express or Fastify through a Fetch adapter. They are not run in
CI. The CLI, MCP stdio, the MCP client facade, and the supporting tools remain
Node.js packages.

## Consequences

- An engine can be mounted inside a host-owned server or deployed to a Fetch
  runtime without a second protocol implementation or execution path.
- Both adapters share one set of boundary rules, so a future rule change
  applies to Node.js and Fetch hosts together.
- On hosts without `process.getBuiltinModule`, proxies at non-JSON boundaries
  may have their traps invoked; JSON values still reject proxies.
- A Fetch host cannot reveal repeated `Authorization` fields; authenticators
  must reject a value that is not exactly one credential.
- The package declares a second public entry point, which the release
  verification packs and imports.
- Invokta adds no framework dependency, stateful session, server-to-client
  stream, or runtime-specific adapter beyond the Node.js listener.
