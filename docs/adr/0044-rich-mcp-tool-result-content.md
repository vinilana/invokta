# ADR 0044: Rich MCP tool result content

- Status: Accepted
- Date: 2026-11-05

## Context

Every successful MCP tool result is one JSON text block plus
`structuredContent` (AE-MCP-01). MCP `2025-11-25` also defines `image`,
`audio`, and `resource_link` content blocks that clients can render or pass to
a model natively. A capability had no way to produce them: `image-engine`
returned base64 inside JSON, an agent received a long string instead of an
image, and every image crossed the wire twice, in `structuredContent` and in
the text block.

The core stays transport-neutral (AE-ARCH-01, ADR 0006): capability
definitions, `ExecutionContext`, and core types cannot carry MCP content types
or MCP concepts. Each capability output is already described by a Standard JSON
Schema that adapters read through `describe()` (ADR 0002). JSON Schema 2020-12
defines a content vocabulary, `contentEncoding` and `contentMediaType`, for
strings whose content has an encoding or a media type.

## Considered options

1. **Output-schema annotations.** The MCP adapter derives the presentation from
   standard JSON Schema content keywords in the capability's own output
   contract. The declaration lives with the contract and is visible to clients
   in `outputSchema`. Stdio, HTTP, devtools adapter emulation, and every entry
   point apply it identically because they share the tool catalog. The mapping
   is a pure function of the captured schema, the validated output, and the
   negotiated protocol revision, and it adds no adapter option and no core
   concept.
2. **An explicit adapter option**, for example `presentResult` keyed by
   capability ID on `serveMcpStdio` and `serveMcpHttp`, returning content blocks
   from the validated output. Every entry point, including the stdio and HTTP
   composition roots, devtools children, and generated starters, would have to
   repeat the same option or the channels would drift. The presentation would
   live away from the contract, invisible to `tools/list` and
   `validateMcpToolCatalog`. It would run engine code inside the adapter after
   `engine.invoke`, where it could perform I/O or throw, and its returned blocks
   would still need the same validation. It would also add MCP-specific public
   API.
3. **A presentation field on the capability.** Rejected: it puts an MCP concept
   in the core and adds a capability field outside AE-CAP-01.

Option 1 is accepted. Every form requires an explicit content keyword; an
object shape alone, such as `{ uri, name }`, never opts in. Recognizing a
resource link from its property names alone was rejected because ordinary
outputs such as an author record commonly have that shape.

## Decision

### Recognized forms

When `@invokta/mcp` builds the tool catalog shared by stdio and HTTP, it derives
one content plan per tool from the captured output JSON Schema. Only the own
`properties` of the object root are read, in declaration order. `$ref`,
`anyOf`, `oneOf`, `allOf`, type arrays, nested properties, and nested arrays
are not followed. A top-level property is planned when its schema, or the
`items` schema of a `type: "array"` property, is one of these forms:

| Form | Property schema | Block |
| --- | --- | --- |
| Typed media | `type: "string"`, `contentEncoding: "base64"`, and an allowlisted `contentMediaType` | `image` or `audio` with that media type |
| Media object | `type: "object"` with a `mimeType` string property whose `const` or `enum` lists only allowlisted media types, and exactly one other string property with `contentEncoding: "base64"` | `image` or `audio` with the value's own `mimeType` |
| Resource link | `type: "object"` whose `uri` string property declares `contentMediaType: "text/uri-list"` (RFC 2483), with a string `name` property and an optional string `mimeType` property; other properties are allowed and not mapped | `resource_link` with `uri`, `name`, and `mimeType` when present |

The media-type allowlist is `image/png`, `image/jpeg`, `image/gif`,
`image/webp`, `audio/wav`, `audio/mpeg`, `audio/ogg`, `audio/webm`,
`audio/flac`, and `audio/aac`, in exact lowercase without parameters. SVG is
excluded because it is active content. The link marker is the exact lowercase
`text/uri-list`. Any other annotation remains an ordinary JSON Schema
annotation and never produces a block. Planning reads only the frozen
`describe()` snapshot and never throws, so no annotation can stop an engine's
catalog from being constructed.

### Authoring

With Zod 4, `.meta()` adds the content keywords and `z.httpUrl()` restricts a
link to `http` and `https`:

```ts
output: z.object({
  chart: z
    .string()
    .meta({ contentEncoding: "base64", contentMediaType: "image/png" })
    .refine(isBase64),
  speech: z.object({
    mimeType: z.enum(["audio/wav", "audio/mpeg"]),
    data: z.string().meta({ contentEncoding: "base64" }).refine(isBase64),
  }),
  sources: z
    .array(
      z.object({
        uri: z.httpUrl().meta({ contentMediaType: "text/uri-list" }),
        name: z.string().min(1),
        mimeType: z.string().optional(),
      }),
    )
    .max(10),
});
```

`isBase64` stands for an engine-owned, linear validator such as image-engine's
`isBoundedBase64`. `z.base64()` also emits `contentEncoding: "base64"`, but its
JSON Schema `pattern` makes AJV-based clients, including the official
TypeScript SDK client that validates `structuredContent`, exhaust the stack on
strings of about 4 MiB. Media contracts therefore declare the keywords on a
plain string and validate it without a regular expression.

### Result presentation

Each planned value is validated independently, without assuming the schema
library enforced the annotation:

- base64 data is non-empty, has a length that is a multiple of four, uses the
  standard RFC 4648 alphabet, and has at most two trailing `=`;
- a media object's `mimeType` value is declared by its schema and allowlisted;
- a resource-link `uri` has at most 8,192 characters, no whitespace, control
  character, or backslash, an `http://` or `https://` scheme in any case, and a
  non-empty raw authority without `@`; it must parse as a URL with a host. The
  block carries the URL's normalized serialization, which must also be at most
  8,192 characters of RFC 3986 characters with well-formed percent-encoding. A
  link is therefore never sent in a form that another URI parser could read
  with a different authority;
- a link `name` is non-empty and at most 1,024 UTF-8 bytes; and
- a present link `mimeType` is an RFC 9110 media type, parameters included, of
  at most 255 characters.

A valid value becomes one block. An invalid value produces no block and stays in
the text block unchanged; it never affects another value, including the other
elements of the same array.

Generated blocks also follow the protocol revision that governs the request.
`image` exists in every supported revision, `audio` since `2025-03-26`, and
`resource_link` since `2025-06-18`. Over stdio the revision is the one the
`initialize` exchange negotiated. Over stateless HTTP, through `serveMcpHttp`
or the Web handler of ADR 0042, it is the request's `MCP-Protocol-Version`
header, which the SDK transport validates; a request
without the header uses `2025-03-26`, as the specification prescribes. A value
whose block type the revision does not define stays in the text block like an
invalid value.

A presented result contains the JSON text block, followed by the generated
blocks in plan order and array elements in index order. `structuredContent`
remains the complete validated output, because MCP requires it to conform to
`outputSchema`. The text block is the JSON serialization of that output in
which every base64 string carried by a block is replaced, in place, by the
placeholder `[content N: <media type>]`, where `N` is the block's index in the
`content` array. Keys, nesting, array positions, value types, and every other
value stay identical, so the text remains structurally equivalent to
`structuredContent` and names the block that holds each binary value. This is
the only difference from the serialized JSON that MCP recommends; it avoids
sending each base64 value three times. Resource links stay unchanged in the
text block.

The adapter returns the legacy result, one text block with the JSON of the
complete output plus `structuredContent`, when the plan is empty, when no value
produces a block, or when more than 16 planned values are present in the
result, counting each array element. The block limit is atomic and checked
before any value is mapped, so the work per result is bounded. An absent
optional property or an empty array contributes nothing. A fallback is neither
an error result nor a diagnostic. Error results and `tools/list` are unchanged.

### Diagnostics

`validateMcpToolCatalog(engine)` still throws `McpToolNameCollisionError` for an
ambiguous catalog and now returns a frozen report. Its `contentWarnings` list,
in catalog and property order, holds one entry per affected top-level property,
with the capability ID, tool name, property name, and one code:

| Code | Meaning |
| --- | --- |
| `UNSUPPORTED_MEDIA_TYPE` | An `image/` or `audio/` media type outside the exact allowlist, including another case, parameters, `image/jpg`, or SVG |
| `MEDIA_WITHOUT_BASE64` | An allowlisted media type whose declared `contentEncoding` is not `base64` |
| `AMBIGUOUS_MEDIA_OBJECT` | A media object with more than one base64 property |
| `INCOMPLETE_RESOURCE_LINK` | A `text/uri-list` marker in another spelling, outside a link object, or without a string `uri`, a string `name`, or a string `mimeType` |
| `UNSUPPORTED_POSITION` | A content annotation inside a union, a type array, a nested object, or a nested array; `$ref` targets are not inspected |
| `CONTENT_BLOCK_LIMIT` | The contract permits more than 16 planned values, for example an array without `maxItems` |

Only explicit content signals warn: a media-like `contentMediaType`, or a
media-like `mimeType` enum, counts only together with a `contentEncoding`
keyword, and a `text/uri-list` marker always counts. Media metadata without
encoded data and inline text such as SVG markup stay silent. Warnings read only
the contract, never a value, and never fail validation; a schema that the
diagnostics cannot read produces no warning. Later minor releases may add
warning codes, so consumers treat an unknown code as a warning.
`invokta check-mcp` prints them on standard error after the module and export
lines and still exits `0`. This amends the silent success of ADR 0026 for this
case only; a catalog without warnings remains silent.

### Boundaries

The adapter does not serve linked resources through `resources/read`, produce
embedded resources, set content annotations, `_meta`, `title`, `description`,
`size`, or `icons`, or follow schema references. It adds no byte limit: blocks
reuse validated output strings, so their size remains bounded by the
capability's output contract, as before. The core, CLI, and direct invocation
are unchanged.

## Consequences

- A capability opts in once, in its contract, and both MCP transports present
  its results identically without entry-point configuration.
- A capability without a recognized form is presented byte for byte as before.
- One invalid value, or a value that an older client's revision cannot
  receive, loses only its own block.
- A capability that already declared a recognized form now receives content
  blocks, and its text block carries placeholders instead of the duplicated
  base64. MCP consumers that parsed that text block for the base64 data must
  read `structuredContent`.
- Authors see close-but-unsupported annotations and an unbounded contract in
  their existing `check-mcp` gate instead of discovering missing blocks at
  runtime.
- The adapter observes the SDK's own `initialize` negotiation by wrapping the
  handler the SDK registers; an SDK update that changes that registration
  requires the review and the protocol-revision tests of ADR 0006.
- Per-result media types require the media-object convention; a different
  shape, another media type, embedded resources, or block annotations require
  another decision.

## Decision evidence

- [MCP 2025-11-25 tool results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-result)
- [MCP 2025-03-26 changelog: audio content](https://modelcontextprotocol.io/specification/2025-03-26/changelog)
- [MCP 2025-06-18 changelog: resource links](https://modelcontextprotocol.io/specification/2025-06-18/changelog)
- [MCP Streamable HTTP protocol version header](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#protocol-version-header)
- [JSON Schema 2020-12 content vocabulary](https://json-schema.org/draft/2020-12/json-schema-validation#name-a-vocabulary-for-the-conten)
- [RFC 2483 `text/uri-list`](https://www.rfc-editor.org/rfc/rfc2483#section-5)
- [RFC 3986 URI syntax](https://www.rfc-editor.org/rfc/rfc3986#section-2)
- [RFC 4648 base64 encoding](https://www.rfc-editor.org/rfc/rfc4648#section-4)
- [RFC 9110 media types](https://www.rfc-editor.org/rfc/rfc9110#section-8.3.1)
