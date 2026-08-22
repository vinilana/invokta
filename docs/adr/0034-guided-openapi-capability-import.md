# ADR 0034: Guided OpenAPI capability import

- Status: Accepted
- Date: 2026-08-21

## Context

ADRs 0012 and 0018 define deterministic engine starter profiles, while ADR
0020 permits one explicitly selected public GitHub example to replace a
profile scaffold. Authors who already own an HTTP API contract still have to
copy its operations, schemas, request serialization, authentication needs, and
response handling into capabilities by hand.

An OpenAPI document describes HTTP operations and connection mechanics. It
does not prove that an operation is a domain action, define who may invoke an
Invokta capability, or provide runtime credentials. Treating every document as
an automatically trusted Action Engine would violate the capability-first and
explicit-access invariants. The useful boundary is therefore a guided code
generator: discover candidate operations, infer only connection facts stated
by the document, let the author remove unwanted endpoints, and emit ordinary
user-owned engine code for review.

## Decision

This decision extends ADRs 0012, 0018, 0020, and 0026 with one local OpenAPI
import mode owned by `create-invokta-engine`. The target, profile, prompt,
exclusive-write, rollback, installation, generated MCP conformance, and
single-`engine.invoke` boundaries remain in force.

### Command and interaction

The command surface becomes:

```text
create-invokta-engine [project-directory]
  [--profile complete|mcp-stdio|mcp-http|cli]
  [--example <name|github-url>]
  [--example-path <subdir>]
  [--openapi <local-json-or-yaml-file>]
  [--exclude <operation-id|METHOD:/path>]...
  [--package-manager npm|pnpm|yarn]
  [--no-install]
  [--yes]
create-invokta-engine --help
create-invokta-engine --version
```

**AE-CREATE-OPENAPI-01 — Mode.** `--openapi` and `--example` are mutually
exclusive. `--example-path` still requires `--example`, and `--exclude`
requires `--openapi`. OpenAPI import may use any existing starter profile. The
existing profile default and prompt remain unchanged.

**AE-CREATE-OPENAPI-02 — Selectors.** Each operation has the canonical selector
`METHOD:/path`, with the method in uppercase and the OpenAPI path template
preserved. A non-empty `operationId` that occurs on exactly one operation is an
additional selector alias. Missing or duplicate operation IDs do not hide
operations; a duplicate operation ID is an ambiguous alias. A selector that
resolves through canonical and alias forms to more than one operation is also
ambiguous. An unknown or ambiguous exclusion fails before mutation as
`OPENAPI_SELECTION_INVALID`. Repeating the same resolved exclusion is
idempotent.

**AE-CREATE-OPENAPI-03 — Default selection.** Interactive import prints one
deterministic numbered catalog. Eligible operations are visibly selected by
default; ineligible operations are visibly unselected and include one stable
reason. The exclusion prompt accepts a comma-separated set of eligible catalog
numbers and an empty answer excludes nothing. The existing 4,096-byte strict
UTF-8 line limit and three-invalid-answer limit apply. Selecting an ineligible
or unknown number is invalid.

If analysis yields more than 100 eligible operations, import fails before the
selection prompt as `OPENAPI_LIMIT_EXCEEDED`; an author must narrow the source
contract rather than interact with a default selection that cannot be
generated. After exclusion, the creator displays the selected count and its
sanitized connection/configuration summary as part of the existing
immutable-plan confirmation. A negative confirmation remains a successful,
side-effect-free cancellation.

If the catalog has no eligible operation, interactive use still displays its
bounded ineligible rows and reasons but does not prompt for exclusions or
confirmation; import fails as `OPENAPI_UNSUPPORTED`. The same condition fails
non-interactive use without rendering a terminal catalog.

Non-interactive import never reads standard input. Every eligible operation is
selected unless a repeatable `--exclude` removes it. Thus an explicit target
with `--openapi` and no exclusions means all eligible operations, including
under `--yes`. At least one operation must remain selected. An empty selection
caused by exclusions fails before mutation as `OPENAPI_SELECTION_INVALID`.

### Local document boundary and discovery

**AE-CREATE-OPENAPI-04 — Local input.** The initial OpenAPI import boundary
supports OpenAPI 3.1.x JSON and YAML entry documents from the local filesystem.
The entry path may be relative to the working directory or absolute and must
resolve to a readable regular file. Import performs no HTTP request, DNS
lookup, operation call, credential lookup, or authentication.

Text decoding is strict UTF-8. YAML uses the JSON schema, requires unique map
keys, disables merge keys, and rejects every alias rather than expanding it.
Non-finite numbers and other values outside the lossless JSON model are
invalid.

Fragment references and relative file references are allowed only within the
real directory containing the entry document. Absolute references, remote
references, path escape, symbolic-link escape, custom schema dialects, and an
unresolvable or cyclic non-schema reference are unsupported. Unsupported data
that affects one operation makes that operation ineligible rather than
silently weakening it. Invalid JSON or YAML, a document other than OpenAPI
3.1.x, or an invalid required OpenAPI structure fails the import.

**AE-CREATE-OPENAPI-05 — Discovery.** The importer discovers only the standard
HTTP operations under `paths`. OpenAPI webhooks, callbacks, overlays, links,
examples, and code execution are out of scope. Catalog order, generated names,
file order, and diagnostics are deterministic for the same creator release and
input bytes. A capability ID is derived deterministically from the unique
operation ID when available and from the canonical method/path selector
otherwise. Derivation cannot silently replace another capability or collide in
the final MCP tool catalog. Generated TypeScript module basenames contain only
portable ASCII characters, are at most 64 characters, and never equal a
Windows device basename case-insensitively. A longer basename retains a
readable prefix plus a deterministic 12-hexadecimal SHA-256 suffix.

### Eligibility and schema mapping

**AE-CREATE-OPENAPI-06 — Eligibility.** An operation is eligible only when the
importer can prove a complete mapping for every effective parameter, request
body, successful response, server, and security requirement that it uses. The
supported parameter boundary is:

- schema-based path, query, header, and cookie parameters;
- primitive values and arrays of primitive values;
- `simple` path and header serialization;
- `form` query and cookie serialization; and
- `deepObject` query serialization for one flat object of scalar values.

Parameter scalars are strings, finite numbers, integers, or booleans; JSON
`null` and an unconstrained boolean schema are not serializable parameters. A
`deepObject` schema must close additional properties or constrain every
additional property to the same non-null scalar boundary. One declared path
parameter supplies every occurrence of its placeholder in the path template.

Parameter `content`, `allowReserved: true`, an unsupported style/explode pair,
or an unsupported value shape makes the operation ineligible. Path parameter
substitution is percent-encoded, and declared query, header, and cookie values
are serialized only in their declared locations.

**AE-CREATE-OPENAPI-07 — Input contract.** The public input is a collision-safe
strict object containing only the applicable groups:

```text
{ path?: {...}, query?: {...}, headers?: {...}, cookies?: {...}, body?: ... }
```

The root and parameter groups set `additionalProperties: false`. A group is
required when it contains a required parameter; a path group is therefore
required whenever path parameters exist. `body` is required exactly when
`requestBody.required` is true. An operation parameter overrides a path
parameter with the same `(in, name)` pair. Public header keys preserve their
declared spelling while HTTP matching remains case-insensitive. OpenAPI header
parameters named `Accept`, `Content-Type`, or `Authorization` are ignored as
required by the OpenAPI parameter rules; media and security declarations own
those headers.

A request body may be absent or use `application/json`. Multipart, binary,
`application/x-www-form-urlencoded`, text, and other request media are not
generated. An eligible operation must declare at least one explicit `2xx` or
`2XX` response. A successful response may be empty or use `application/json`
or `application/*+json`. A `default` response is never inferred to be success.
Undocumented status, non-success status, or unexpected response media becomes
a sanitized dependency failure and is never returned as a capability result.

**AE-CREATE-OPENAPI-08 — Output contract.** The public output is the strict
object `{ status, body? }`. Each explicit numeric 2xx response makes `status`
that constant integer; `2XX` constrains it from 200 through 299. A declared
JSON response schema makes `body` required and validated against that schema.
A response with no content produces only `{ status }` and rejects a body. JSON
content without a schema accepts any lossless JSON body. Multiple successful
variants form a `oneOf` beneath an explicit object-root schema. Response
headers are not exposed in this profile.
`application/json` wins when present; otherwise exactly one concrete
`application/<subtype>+json` media type is required. Multiple suffix-JSON
choices without exact JSON are ambiguous and unsupported.

**AE-CREATE-OPENAPI-09 — Schema contract.** The generated Standard Schema and
Standard JSON Schema contracts preserve a bounded lossless subset of the
OpenAPI 3.1.x JSON Schema vocabulary: local schema references, `type`, `enum`,
`const`, `properties`, `required`, `additionalProperties`, `items`,
`prefixItems`, `anyOf`, `oneOf`, `allOf`, scalar and array bounds, string length
and `pattern`, numeric bounds and `multipleOf`, and `default`. Unsupported
semantic keywords, including `not`, conditionals, `unevaluated*`, `dependent*`,
`uniqueItems`, `contains*`, `patternProperties`, and `propertyNames`, make an
affected operation ineligible. Format metadata may be preserved for
description but MUST NOT be presented as runtime validation unless the
generated validator enforces it. Capability input and output remain
object-rooted and lossless-JSON compatible as required by ADR 0002.

The catalog reports exactly one of these stable ineligibility reasons, using
this precedence when more than one applies:

1. `REFERENCE_UNSUPPORTED`;
2. `SERVER_UNSUPPORTED`;
3. `SECURITY_UNSUPPORTED`;
4. `PARAMETER_UNSUPPORTED`;
5. `REQUEST_BODY_UNSUPPORTED`;
6. `SUCCESS_RESPONSE_MISSING`;
7. `RESPONSE_UNSUPPORTED`;
8. `SCHEMA_UNSUPPORTED`;
9. `CAPABILITY_ID_COLLISION`; or
10. `MCP_TOOL_NAME_COLLISION`.

Every otherwise eligible operation participating in a generated-name collision
receives the applicable collision reason. Ineligible operations cannot be
selected or generated. The importer never drops one unsupported field and
presents the remaining operation as fully supported.

### Connection inference and authentication

**AE-CREATE-OPENAPI-10 — Servers.** The connection plan uses OpenAPI
precedence: operation-level servers replace path-level servers, which replace
root servers; operation-level `security` replaces root security. One effective
usable server is expanded from its declared variable defaults. When no server
is declared, or when alternatives remain, generated runtime configuration
requires an explicit base URL and documents the alternatives without selecting
one. Every referenced server variable must declare a default. Only HTTP and
HTTPS server URLs without user information are supported. No server, variable,
host, or scheme is invented.

**AE-CREATE-OPENAPI-11 — Upstream security.** The initial import boundary
supports anonymous operations, API keys in a declared header/query/cookie
location, and HTTP Basic or Bearer authentication. Security schemes combined
in one requirement are all applied. A combined requirement whose schemes
target the same header (case-insensitively), query key, or cookie key is
`SECURITY_UNSUPPORTED` because applying it would overwrite a credential. For
alternative security requirements, the
generated resolver fails closed unless exactly one complete alternative is
configured; an anonymous alternative applies only when no credentialed
alternative is configured. OAuth 2.0, OpenID Connect, mutual TLS, and custom
HTTP authentication make the affected operation ineligible in this profile. A
future token-provider or OAuth implementation requires a separate contract
decision.

Only environment variable names are generated. Values from the process
environment, an OpenAPI example/default/extension, a URL user-info field, or a
local dotenv file are never read or copied during import.
`upstream.env.example` lists names and safe instructions without credential
values, preserving the deploy-owned `.env.example` bytes in HTTP profiles.
Names are deterministic and collision-free within one generated project; their
exact spelling is creator-version template output rather than a cross-release
configuration guarantee. Upstream security says how the generated dependency
calls the API; it never changes or substitutes the capability's Invokta
`access` rule. Generated candidates declare `public`, matching the local
starter adapters. Interactive final confirmation or an explicit
non-interactive import authorizes generation; the generated README and
instructions require an explicit domain and access review before deployment.

### Generated execution and failure behavior

**AE-CREATE-OPENAPI-12 — Generated project.** OpenAPI import replaces the
welcome capability with exactly the selected candidate modules, registers them
in one shared engine, and emits an engine-owned upstream port, fetch adapter,
runtime configuration, names-only `upstream.env.example`, and fake-port tests.
The output remains readable user-owned TypeScript rather than a framework
runtime registry or a generic OpenAPI proxy. All selected profiles retain their
normal direct and adapter entry points, and every entry point converges on the
generated engine's `invoke` method.

**AE-CREATE-OPENAPI-13 — Runtime boundary.** Each generated capability
delegates HTTP work through the injected upstream port, has a 30,000 ms
capability timeout, and passes `ExecutionContext.signal` to the fetch adapter.
The adapter performs one request, follows no redirect, and adds no retry, cache,
cookie jar, discovery, concurrency control, or background work. It encodes JSON
requests explicitly and rejects a serialized URL over 8,192 UTF-8 bytes or JSON
request body over 10 MiB before `fetch`. It validates the declared successful
response shape and reads at most 10 MiB from the response stream, first
rejecting an oversized valid `Content-Length` and then counting chunks
incrementally. Response text uses fatal UTF-8 decoding before JSON parsing.
Network failures, status failures, media failures, timeout, cancellation, and
response validation follow the existing engine error taxonomy. Public errors,
logs, tests, and generated documentation never contain credentials, request or
response bodies, or credential-bearing URLs. Runtime diagnostics do not echo
raw OpenAPI values.

The operation path is appended as path data and is never interpreted as an
absolute or network-path URL. After path and non-credential parameter
serialization, and again after authentication, the target must retain the
configured base URL's exact origin. A mismatch fails with the sanitized
dependency error before any credential is applied or request is made.

The imported source is not copied into the project and generated code does not
interpret OpenAPI at runtime. Generated tests use a fake upstream port and make
no network request. Every selected operation gets an executable contract and
fake-port-isolation test. A successful invocation is additionally generated for
each declared response variant only when the creator can prove a valid input
and output witness within its bounded deterministic sampler. A supported schema
whose regular expression or intersecting constraints do not yield such a
witness remains eligible; its universal contract and isolation test still
runs. During creator execution, package installation remains the only possible
network activity after local generation, subject to the existing `--no-install`
contract.

### Limits and diagnostics

**AE-CREATE-OPENAPI-14 — Limits and failures.** The OpenAPI import boundary
enforces these inclusive maxima before generation:

| Dimension | Maximum |
| --- | ---: |
| Entry document bytes | 10 MiB |
| Aggregate entry and local-reference bytes | 10 MiB |
| Local documents | 64 |
| Parsed document nodes | 100,000 |
| Reference-resolution work units | 100,000 |
| Document, reference, or schema depth | 64 |
| Discovered operations | 500 |
| Eligible operations | 100 |
| Selected/generated operations | 100 |
| Schema nodes reachable by one operation | 1,000 |
| Generated TypeScript module basename | 64 ASCII characters |
| One `--exclude` selector | 1,024 Unicode scalars |
| Repeated `--exclude` arguments | 500 |
| Serialized runtime URL | 8,192 UTF-8 bytes |
| Serialized JSON request body | 10 MiB |
| Streamed response body at runtime | 10 MiB |

Every maximum is inclusive. Crossing it fails deterministically before further
allocation, network I/O, or JSON decoding where the boundary permits that
check.

Reference resolution memoizes each successfully resolved local container. One
work unit is charged before visiting a previously unresolved parsed node;
copying a `$ref` sibling overlay additionally charges each copied property.
This bound applies before the corresponding allocation or copy and prevents a
branching local-reference graph from expanding exponentially.

The new sanitized diagnostics are:

| Code | Exit | Message |
| --- | ---: | --- |
| `OPENAPI_INVALID` | `2` | `The OpenAPI document is invalid.` |
| `OPENAPI_UNAVAILABLE` | `1` | `The OpenAPI document could not be read.` |
| `OPENAPI_UNSUPPORTED` | `1` | `The OpenAPI document has no supported operation to import.` |
| `OPENAPI_SELECTION_INVALID` | `2` | `The OpenAPI operation selection is invalid.` |
| `OPENAPI_LIMIT_EXCEEDED` | `1` | `The OpenAPI import exceeds a supported limit.` |

Diagnostics may include only a sanitized, bounded canonical selector, unique
operation ID, local project-relative reference path, stable unsupported reason,
or limit name. They never echo a raw document fragment, schema, URL, header,
credential, environment value, body, parser error, stack, or cause. Parsing,
reference resolution, cataloging, selection, connection planning, schema
conversion, and complete scaffold planning occur before the first target write
or package-manager process.

## Consequences

- Authors can turn a bounded local OpenAPI contract into reviewed capability
  candidates without hand-copying HTTP connection details.
- Eligible endpoints are included by default, while interactive and automated
  callers remove unwanted operations explicitly.
- Generated operation wrappers are candidates for domain review, not proof that
  an API mirror is an Action Engine.
- Authentication facts are inferred without importing secrets or conflating
  upstream credentials with Invokta authorization.
- Unsupported operations remain visible with reasons rather than producing
  partially connected capabilities.
- Full OpenAPI code generation, remote specifications, runtime OpenAPI
  interpretation, OAuth token acquisition, multipart/binary transport, and
  universal SDK generation remain out of scope.
