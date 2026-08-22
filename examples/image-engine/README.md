# Multi-provider image engine example

This example publishes four image-production capabilities through the direct
API, CLI, MCP stdio, and stateless MCP HTTP. Each capability chooses an image
provider behind a domain port; consumers request an outcome and never select a
model or send a provider credential.

| Capability | Production use case | Default provider |
| --- | --- | --- |
| `image.edit-asset` | Edit one existing asset while preserving supplied details | OpenAI GPT Image 2 |
| `image.render-text-asset` | Produce posters, covers, and social assets where copy fidelity is the primary concern | OpenAI GPT Image 2 |
| `image.generate-campaign-series` | Generate two to four high-resolution images with coherent art direction | BytePlus Seedream 5.0 Lite |
| `image.compose-reference-asset` | Create a new composition that keeps products, subjects, or brand cues consistent across multiple references | Google Nano Banana 2 |

The defaults reflect the providers' documented strengths as of July 2026:

- [`gpt-image-2`](https://developers.openai.com/api/docs/models/gpt-image-2)
  supports image generation and editing, flexible sizes, and high-fidelity
  image inputs. The example uses the Image Edits endpoint for edits and the
  Image Generations endpoint for copy-heavy assets.
- [`seedream-5-0-260128`](https://docs.byteplus.com/api/docs/ModelArk/1824121)
  supports 2K/3K/4K output and sequential image generation. The example uses it
  for bounded campaign series where cross-image coherence is the primary need.
- [`gemini-3.1-flash-image`](https://ai.google.dev/gemini-api/docs/image-generation),
  currently named Nano Banana 2, is Google's general-purpose native image model
  with multi-reference processing and consistency. The example uses it to
  create a new asset from two to four references, not to edit an existing asset.

Model aliases and recommendations evolve. The composition root therefore allows
every model ID to be overridden without changing a capability contract.

## Architecture

```text
direct / CLI / MCP stdio / MCP HTTP
                |
                v
           engine.invoke
                |
     +----------+-----------+----------------+
     |          |           |                |
     v          v           v                v
 edit asset  render copy  campaign series  reference composition
     |          |           |                |
     +----> GPT Image 2   Seedream 5.0    Nano Banana 2
```

- `src/application/ports.ts` defines outcome-oriented ports. It contains no
  provider SDK or transport type.
- `src/capabilities/` owns the stable Zod 4 contracts, defaults, access rules,
  timeouts, and handlers.
- `src/infrastructure/` is the only layer that knows the three outbound HTTP
  contracts.
- `src/engine.ts` is the composition root. It reads credentials and optional
  model/base-URL overrides, constructs the adapters, and injects them.
- CLI and MCP adapters receive the engine and can execute a capability only
  through `engine.invoke`.

The example uses built-in `fetch`, `FormData`, and `Blob`, so it adds no provider
SDK dependencies. A production engine may use official SDKs behind the same
ports without changing a capability or consumer.

## Configure

All three credentials are required at startup because the four capabilities are
published together:

```sh
export OPENAI_API_KEY='sk-...'
export ARK_API_KEY='...'
export GEMINI_API_KEY='...'
```

The following optional settings support regional endpoints, compatible local
stubs, gateways, and deliberate model upgrades:

| Environment variable | Default |
| --- | --- |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `BYTEPLUS_ARK_BASE_URL` | `https://ark.ap-southeast.bytepluses.com/api/v3` |
| `SEEDREAM_IMAGE_MODEL` | `seedream-5-0-260128` |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` |
| `NANO_BANANA_IMAGE_MODEL` | `gemini-3.1-flash-image` |

Base URLs must use HTTP(S) and cannot contain credentials. Provider keys are
sent only in outbound headers. They never appear in capability inputs, outputs,
events, logs, or public error details.

## Run the example

From the repository root:

```sh
yarn build
```

The direct entrypoint demonstrates the text-fidelity workflow:

```sh
node examples/image-engine/dist/direct.js \
  'A restrained product launch poster with generous whitespace.' \
  'SHIP THE RIGHT THING'
```

List and describe the same capabilities through the CLI:

```sh
node examples/image-engine/dist/cli.js list
node examples/image-engine/dist/cli.js describe image.generate-campaign-series
```

Generate a bounded Seedream campaign series:

```sh
node examples/image-engine/dist/cli.js run image.generate-campaign-series \
  --input '{"prompt":"A connected editorial launch campaign.","count":3,"aspectRatio":"16:9","resolution":"4K"}'
```

Reference images use a JSON-safe object with a MIME type and base64 data. For
example, an image edit input has this shape:

```json
{
  "prompt": "Replace the background with a quiet studio.",
  "referenceImages": [
    {
      "mimeType": "image/png",
      "base64Data": "<BASE64_IMAGE_DATA>"
    }
  ],
  "aspectRatio": "3:2"
}
```

Start the MCP stdio adapter from a trusted local MCP host:

```sh
node examples/image-engine/dist/mcp-stdio.js
```

Start authenticated stateless MCP HTTP on loopback:

```sh
IMAGE_ENGINE_BEARER_TOKEN='development-only-token' \
  node examples/image-engine/dist/mcp-http.js
```

The literal bearer-token comparison is only a deterministic authentication
example. A real deployment should inject its identity provider at the MCP HTTP
boundary.

## Contracts and operational limits

| Concern | Contract |
| --- | --- |
| Access | All capabilities require a trusted `Principal` |
| Prompt | Trimmed, 1–4,000 characters |
| Required rendered copy | Trimmed, 1–500 characters |
| Reference formats | PNG, JPEG, or WebP |
| Reference size | At most 10 MiB decoded per image |
| Edit references | 1–4 images |
| Composition references | 2–4 images |
| Campaign count | 2–4 images, exactly the requested count |
| Campaign resolution | 2K or 4K; default 2K |
| Generated image size | At most 32 MiB decoded per image |
| Provider response | At most 64 MiB before JSON parsing |
| GPT Image timeout | 150 seconds |
| Seedream campaign timeout | 180 seconds |
| Nano Banana timeout | 150 seconds |

Aspect ratio defaults to `1:1` and accepts `1:1`, `3:2`, `2:3`, `16:9`, or
`9:16`. Every adapter propagates the invocation's `AbortSignal` to `fetch`.

The engine performs one provider request per invocation and implements no retry,
fallback, cache, queue, or concurrency policy. Provider rejection, malformed
payload, incomplete campaign output, and oversized response become
`EXECUTION_FAILED`. Public details contain only the provider name and, when
available, HTTP status or image counts; provider response bodies remain internal.

Generated images are returned inline as base64 so direct, CLI, and MCP consumers
observe the same output contract. Hosts should account for that bounded payload
when selecting their own transport and process memory limits.

Provider choice expresses the best-fit production path, not a deterministic
visual-quality guarantee. This example validates schemas, counts, formats, and
sizes, but it does not run OCR or perceptual evaluations. A production workflow
that requires provably exact copy, brand identity, or cross-image consistency
should add an eval and human-approval step after this capability returns.

## Verify the example

The tests use local provider stubs and never call OpenAI, BytePlus, or Google:

```sh
yarn workspace @invokta/example-image test
yarn workspace @invokta/example-image typecheck
yarn workspace @invokta/example-image build
```

## Inspect and gate this engine

This composition root needs provider credentials, so it publishes no
credential-free constructed engine for `invokta-devtools serve` or
`invokta check-mcp` to import. The portable MCP tool names are gated in
[`test/image-engine.test.ts`](./test/image-engine.test.ts) instead, where
`validateMcpToolCatalog` runs against the engine built from the test doubles and
fails when two capability IDs derive the same alias.

With the credentials exported, verify the built stdio adapter:

```sh
yarn workspace @invokta/example-image devtools:verify
```

`invokta-devtools verify` initializes the server and reads the complete
paginated `tools/list` without calling a tool, exiting `1` when the target or
protocol fails. To drive one deliberate call by hand, attach the same command in
the idle MCP workbench:

```sh
npx invokta-devtools open --mcp
```
