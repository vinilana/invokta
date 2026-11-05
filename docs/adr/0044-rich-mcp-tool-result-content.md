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
strings that carry encoded binary data.

## Considered options

1. **Output-schema annotations.** The MCP adapter derives the presentation from
   standard JSON Schema keywords in the capability's own output contract. The
   declaration lives with the contract and is visible to clients in
   `outputSchema`. Stdio, HTTP, devtools adapter emulation, and every entry
   point apply it identically because they share the tool catalog. The mapping
   is a pure function of the captured schema and the validated output, and it
   adds no option, export, or core concept. Its costs are a documented
   convention for per-result media types and links, and a behavior change for
   a capability that already declared a recognized form.
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

Option 1 is accepted. It is explicit in the contract, deterministic, testable
without a transport, identical in both MCP transports, and configured once.

## Decision

### Recognized forms

When `@invokta/mcp` builds the tool catalog shared by stdio and HTTP, it derives
one content plan per tool from the captured output JSON Schema. Only the own
`properties` of the object root are read, in declaration order. `$ref`,
`anyOf`, `oneOf`, `allOf`, type arrays, and nested properties are not followed.
A top-level property is planned when its schema, or the `items` schema of a
`type: "array"` property, is one of these forms:

| Form | Property schema | Block |
| --- | --- | --- |
| Typed media | `type: "string"`, `contentEncoding: "base64"`, and an allowlisted `contentMediaType` | `image` or `audio` with that media type |
| Media object | `type: "object"` with a `mimeType` string property whose `const` or `enum` lists only allowlisted media types, and exactly one other string property with `contentEncoding: "base64"` | `image` or `audio` with the value's own `mimeType` |
| Resource link | `type: "object"` with exactly the properties `uri` (string, `format: "uri"`), `name` (string), and optional `mimeType` (string) | `resource_link` with `uri`, `name`, and `mimeType` when present |

The media-type allowlist is `image/png`, `image/jpeg`, `image/gif`,
`image/webp`, `audio/wav`, `audio/mpeg`, `audio/ogg`, `audio/webm`,
`audio/flac`, and `audio/aac`, in exact lowercase without parameters. SVG is
excluded because it is active content. Any other annotation, including base64
without an allowlisted `contentMediaType`, remains an ordinary JSON Schema
annotation and never produces a block. Planning reads only the frozen
`describe()` snapshot and never throws, so no annotation can stop an engine's
catalog from being constructed.

With Zod 4, `z.base64()` emits `contentEncoding: "base64"`, `.meta()` adds
`contentMediaType`, and `z.url()` emits `format: "uri"`:

```ts
output: z.object({
  chart: z.base64().meta({ contentMediaType: "image/png" }),
  speech: z.object({
    mimeType: z.enum(["audio/wav", "audio/mpeg"]),
    data: z.base64(),
  }),
  sources: z.array(
    z.object({
      uri: z.url(),
      name: z.string(),
      mimeType: z.string().optional(),
    }),
  ),
});
```

### Result presentation

The adapter validates every planned value it maps, without assuming the schema
library enforced the annotation:

- base64 data is non-empty, has a length that is a multiple of four, uses the
  standard RFC 4648 alphabet, and has at most two trailing `=`;
- a media object's `mimeType` value is declared by its schema and allowlisted;
- a resource-link `uri` is printable ASCII without spaces, at most 8,192 bytes,
  starts with `https://` or `http://`, and parses as a URL with a host and no
  user information; `name` is non-empty and at most 1,024 UTF-8 bytes; and a
  present `mimeType` is an RFC 6838 `type/subtype` without parameters.

A presented result contains the JSON text block, followed by the generated
blocks in plan order and array elements in index order. `structuredContent`
remains the complete validated output, because MCP requires it to conform to
`outputSchema`. The text block is the JSON serialization of the output without
the base64 values that a generated block carries: a typed media property, or a
non-empty array of them, is omitted, and inside a media object only its base64
property is omitted. Resource links stay in the text block. Each base64 value
is therefore sent twice instead of three times, and a text-only client still
receives every other field.

Presentation is atomic. The adapter returns the legacy result, one text block
with the JSON of the complete output plus `structuredContent`, when the plan is
empty, no planned value is present, a present planned value is invalid, or the
result would generate more than 16 blocks. An absent optional property or an
empty array contributes no block and is not an error. A fallback is neither an
error result nor a diagnostic; it returns only the validated output, as before.
Error results and `tools/list` are unchanged.

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
- A capability that already declared a recognized form now receives content
  blocks and a text block without the duplicated base64. MCP consumers that
  parsed that text block for the base64 data must read `structuredContent`.
- Per-result media types require the media-object convention; a different
  shape, another media type, embedded resources, or block annotations require
  another decision.

## Decision evidence

- [MCP 2025-11-25 tool results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-result)
- [JSON Schema 2020-12 content vocabulary](https://json-schema.org/draft/2020-12/json-schema-validation#name-a-vocabulary-for-the-conten)
- [RFC 4648 base64 encoding](https://www.rfc-editor.org/rfc/rfc4648#section-4)
- [RFC 6838 media type names](https://www.rfc-editor.org/rfc/rfc6838#section-4.2)
