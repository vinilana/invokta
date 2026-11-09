# @invokta/http

Plain HTTP JSON adapter for Invokta Action Engines. It publishes each
capability as an HTTP route, generates an OpenAPI 3.1 description of those
routes, and executes every call through `engine.invoke` with source `http`.

The main export is a Web-standard handler, `(request: Request) =>
Promise<Response>`, whose package-root modules import no Node.js built-in
module. `@invokta/core` imports none either (ADR 0042), so the handler runs on
Fetch runtimes; Node.js is the runtime verified by tests. The optional
`@invokta/http/node` subpath serves the same handler on `node:http`.

```sh
yarn add @invokta/http
```

## Handler

```ts
import { createHttpHandler } from "@invokta/http";

import { authenticate } from "./http-auth.js";
import { engine } from "./engine.js";

export const handler = createHttpHandler(engine, {
  basePath: "/api",
  allowedHosts: ["engine.example"],
  auth: { mode: "required", authenticate },
});
```

| Method and path | Response |
| --- | --- |
| `GET {basePath}/capabilities` | `{ "capabilities": engine.list() }` |
| `GET {basePath}/capabilities/{id}` | `engine.describe(id)` |
| `POST {basePath}/capabilities/{id}` | The validated output of `engine.invoke(id, body)` |
| `GET {basePath}/openapi.json` | The generated OpenAPI 3.1 document |

`{id}` is the capability key as one percent-encoded path segment, resolved
against the catalog captured at construction, so an unknown ID is a 404 that
never reaches `engine.invoke`. The `POST`
body must be `application/json`, strict UTF-8, and at most 1,048,576 bytes by
default (`maxRequestBodyBytes`). `request.signal` reaches the authenticator and
`engine.invoke`, so a client disconnect cancels the invocation.

Errors use one body, `{ "error": { "code", "message", "publicDetails"? } }`,
without causes or stacks:

| Status | Codes |
| --- | --- |
| 400 | `INPUT_INVALID`, `INVALID_JSON`, `INVALID_REQUEST` |
| 401 | `UNAUTHENTICATED` with `WWW-Authenticate: Bearer` |
| 403 | `FORBIDDEN`, `HOST_NOT_ALLOWED`, `ORIGIN_NOT_ALLOWED` |
| 404 | `CAPABILITY_NOT_FOUND`, `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` with `Allow` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `DOMAIN_ERROR` (a declared domain error) |
| 500 | `OUTPUT_INVALID`, `EXECUTION_FAILED`, `INTERNAL_ERROR` |
| 503 | `CANCELLED` |

## Security defaults

- `auth` is required: `{ mode: "required", authenticate }` or the explicit
  `{ mode: "dangerously-disabled-for-development" }`. The authenticator receives
  `{ path, method, headers: { get, has }, signal }`, the same structure as the
  MCP HTTP adapter, so one authenticator serves both. Required mode protects
  every route, including `openapi.json`.
- `allowedHosts` defaults to the loopback names; deployments list their public
  host names.
- CORS is off: any request with an `Origin` header is rejected unless
  `cors.allowedOrigins` lists it exactly. Preflights are answered before
  authentication.
- Bodies are bounded, and every response is `no-store` and `nosniff`.
- An optional synchronous `visibility({ principal, capabilityId })` predicate
  limits listing, description, OpenAPI, and invocation to the capabilities
  visible to the caller; a hidden ID answers exactly like an unknown one, 404
  `CAPABILITY_NOT_FOUND`, before the body is read. Visibility never grants
  access; the access rule still runs on every invocation.

## OpenAPI export

`createHttpOpenApiDocument(engine, { basePath, security })` returns the same
document the handler serves, built only from `engine.list()` and
`engine.describe()`. Use it to publish the contract from a build step.

## Node

```ts
import { serveHttp } from "@invokta/http/node";

const server = await serveHttp(engine, {
  port: 3000,
  auth: { mode: "required", authenticate },
});
```

`serveHttp` binds `127.0.0.1:3000` by default, requires `allowedHosts` for a
non-loopback bind, accepts only an origin-form target that URL normalization
leaves unchanged with exactly one `Host` and at most one `Authorization`
header, aborts the invocation when the client disconnects, and closes
idempotently. On Deno, Bun, or Cloudflare Workers, pass the handler to the
runtime's server instead.

See the [reference](https://docs.invokta.dev/reference/http/) and
[ADR 0048](../../docs/adr/0048-plain-http-json-adapter-with-openapi-export.md).
