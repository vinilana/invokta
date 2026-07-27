# Hello Engine

This is the smallest complete AI Engine example. It defines
`onboarding.create-welcome-message` once and exposes it through direct
invocation, the CLI, MCP stdio, and stateless MCP HTTP.

The bundled `GreetingWriter` is deterministic so the example runs without an AI
provider account. Replace that injected port with a model-backed implementation
without changing the capability contract or any adapter.

## Build and test

From the repository root:

```bash
yarn workspace @ai-engine/example-hello build
yarn workspace @ai-engine/example-hello test
```

## Direct invocation

```bash
node examples/hello-engine/dist/direct.js Ada
```

## CLI

```bash
node examples/hello-engine/dist/cli.js list
node examples/hello-engine/dist/cli.js describe onboarding.create-welcome-message
node examples/hello-engine/dist/cli.js run onboarding.create-welcome-message --input '{"name":"Ada"}'
printf '{"name":"Ada"}' | node examples/hello-engine/dist/cli.js run onboarding.create-welcome-message --stdin
```

The local principal is supplied by the composition root, not by a command-line
flag.

## MCP stdio

```bash
node examples/hello-engine/dist/mcp-stdio.js
```

The process reserves stdout for MCP messages. Its local principal is trusted
configuration in the composition root. Start this transport with `node` rather
than a package-manager wrapper so the wrapper cannot write status text to the
protocol stream.

## Stateless MCP HTTP

Set a development-only bearer token and start the loopback server:

```bash
HELLO_ENGINE_DEMO_TOKEN='replace-with-a-local-secret' \
  node examples/hello-engine/dist/mcp-http.js
```

The endpoint is `http://127.0.0.1:3000/mcp`. Set `HELLO_ENGINE_PORT` to use a
different port. Requests must include:

```text
Authorization: Bearer replace-with-a-local-secret
```

For example, call the published tool with `curl`:

```bash
curl --fail-with-body http://127.0.0.1:3000/mcp \
  --header 'Accept: application/json, text/event-stream' \
  --header 'Authorization: Bearer replace-with-a-local-secret' \
  --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":"hello-1","method":"tools/call","params":{"name":"onboarding.create-welcome-message","arguments":{"name":"Ada"}}}'
```

The response contains the validated result in `result.structuredContent`:

```json
{
  "jsonrpc": "2.0",
  "id": "hello-1",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"message\":\"Hello, Ada! Welcome to your first AI Engine.\"}"
      }
    ],
    "structuredContent": {
      "message": "Hello, Ada! Welcome to your first AI Engine."
    }
  }
}
```

This equality check is intentionally a local authentication-hook demonstration,
not production identity. It does not issue, validate, refresh, or persist real
tokens. In production, keep `mode: "required"` and replace the hook with your
organization's existing identity implementation. Never commit the demo token.
