# Getting started: one capability, four entry points

This guide builds a small domain capability and exposes the same implementation
through a direct call, the CLI, MCP stdio, and stateless MCP Streamable HTTP. The
examples use Zod 4, but the core accepts any schema that implements both Standard
Schema v1 and Standard JSON Schema v1.

For complete, runnable compositions, see
[`hello-engine`](../examples/hello-engine/) and
[`support-engine`](../examples/support-engine/). The hello example is the shortest
onboarding path. The support example demonstrates injected ports and a domain
authorization rule.

## Prerequisites

- Node.js 22.20.0 or later;
- Yarn 1.22.22 for this repository;
- an ESM TypeScript project;
- `@ai-engine/core`, and the adapter packages needed by the chosen entry points;
- a compatible schema implementation, such as Zod 4.

When working in this repository, install and build from its root:

```sh
yarn install --frozen-lockfile
yarn build
```

## 1. Define the capability once

Create `src/engine.ts`:

```ts
import { createEngine, defineCapability } from "@ai-engine/core";
import { z } from "zod";

const createWelcomeMessage = defineCapability({
  description: "Create a welcome message for a new team member.",
  input: z.object({
    name: z.string().trim().min(1),
  }),
  output: z.object({
    message: z.string(),
  }),
  access: "public",
  async run({ input }) {
    return { message: `Welcome, ${input.name}!` };
  },
});

export const engine = createEngine({
  name: "hello-engine",
  version: "0.1.0",
  capabilities: {
    "onboarding.create-welcome-message": createWelcomeMessage,
  },
});
```

The capability ID is the key in `capabilities`; it is not repeated in the
definition. The required fields are `description`, `input`, `output`, `access`,
and `run`. Both schemas have an object root so the same contracts can be exposed
as MCP tool schemas.

The repository's hello capability is an expanded version with an injected
writer, authenticated access, and annotations:
[`create-welcome-message.ts`](../examples/hello-engine/src/capabilities/create-welcome-message.ts).

For a dependency-injected capability, compare the support example's
[`classify-ticket.ts`](../examples/support-engine/src/capabilities/classify-ticket.ts)
with its explicit application
[`ports`](../examples/support-engine/src/application/ports.ts) and
[`composition root`](../examples/support-engine/src/engine.ts).

## 2. Invoke it directly

Create `src/direct.ts`:

```ts
import { engine } from "./engine.js";

const result = await engine.invoke(
  "onboarding.create-welcome-message",
  { name: "Ada" },
  {
    source: "direct",
    principal: null,
  },
);

process.stdout.write(`${JSON.stringify(result)}\n`);
```

`invoke` validates and transforms the input, enforces `access`, runs the handler,
and validates and transforms the output. A protected capability receives its
trusted `Principal` through the invocation options, never through the business
input.

The runnable entry point for that expanded example is
[`examples/hello-engine/src/direct.ts`](../examples/hello-engine/src/direct.ts).
After the repository build:

```sh
node examples/hello-engine/dist/direct.js Ada
```

## 3. Add the CLI entry point

Create `src/cli.ts`:

```ts
import { runCli } from "@ai-engine/cli";

import { engine } from "./engine.js";

const exitCode = await runCli(engine, {
  principal: { id: "local:developer" },
});

process.exitCode = exitCode;
```

The composition root owns the local principal and process exit code. There is no
CLI option for choosing an actor, role, or identity. `runCli` uses
`engine.invoke` for `run`; it does not call the capability handler directly.

The runnable entry point is
[`examples/hello-engine/src/cli.ts`](../examples/hello-engine/src/cli.ts). Its
supported commands are:

```sh
node examples/hello-engine/dist/cli.js list
node examples/hello-engine/dist/cli.js describe onboarding.create-welcome-message
node examples/hello-engine/dist/cli.js run onboarding.create-welcome-message --input '{"name":"Ada"}'
printf '%s' '{"name":"Ada"}' | node examples/hello-engine/dist/cli.js run onboarding.create-welcome-message --stdin
```

JSON is the canonical output. Standard output contains only the requested
result; diagnostics belong on standard error.

## 4. Add the MCP stdio entry point

Create `src/mcp-stdio.ts`:

```ts
import { serveMcpStdio } from "@ai-engine/mcp";

import { engine } from "./engine.js";

await serveMcpStdio(engine, {
  principal: { id: "local:mcp-host" },
});
```

The process that starts the server supplies the trusted local principal. Standard
output is reserved for MCP messages, so write application diagnostics only to
standard error. Closing the client input closes the protocol connection, cancels
active capability work, and lets the server process shut down. Run the built
entry point directly with Node to avoid package-manager status text on the
protocol stream:

```sh
node examples/hello-engine/dist/mcp-stdio.js
```

An MCP client will discover `onboarding.create-welcome-message` as one tool with
the capability's original input schema, output schema, description, and optional
annotations.

## 5. Add the stateless HTTP entry point

For a local-only first connection, create `src/mcp-http.ts` with the explicit
development opt-out:

```ts
import { serveMcpHttp } from "@ai-engine/mcp";

import { engine } from "./engine.js";

const server = await serveMcpHttp(engine, {
  host: "127.0.0.1",
  port: 3000,
  auth: {
    mode: "dangerously-disabled-for-development",
  },
});

const { host, port } = server.address();
process.stderr.write(`MCP endpoint: http://${host}:${port}/mcp\n`);
```

This mode is deliberately named as a warning. It supplies no principal, must not
be used for a shared or production deployment, and cannot satisfy
`authenticated` capabilities. Prefer `auth.mode: "required"` and an
authentication hook, as described in the
[HTTP authentication guide](./http-authentication.md).

The runnable hello entry point uses required authentication, not the development
opt-out:

```sh
HELLO_ENGINE_DEMO_TOKEN='replace-with-a-local-secret' \
  node examples/hello-engine/dist/mcp-http.js
```

Its equality check is intentionally a local demonstration, not a production
token verifier. The server binds to `127.0.0.1` by default and exposes only
`POST /mcp`, plus a public Protected Resource Metadata route when configured.
Every accepted POST gets a fresh MCP server, transport, and principal. There is
no session, resumption, or cross-request cancellation guarantee.

Request bodies are bounded to 1 MiB by default. A host may lower or raise this
finite limit with `maxRequestBodyBytes` according to its capability contracts
and deployment boundary.

Host is checked on every request before authentication. An absent `Origin` is
accepted for non-browser clients; a supplied origin is accepted only when it
exactly matches an explicitly configured HTTP(S) origin. Host or Origin rejection
uses HTTP 403. By contrast, a capability authorization denial is an MCP tool
execution error with `isError: true` inside an HTTP 200 protocol response.

## 6. Verify reuse rather than duplicate it

All four entry points import the same `engine`. Only the composition roots differ:

| Entry point | Trusted boundary data | Execution source |
| --- | --- | --- |
| Direct | caller-supplied principal and signal | `direct` |
| CLI | composition-root local principal | `cli` |
| MCP stdio | process-configured local principal | `mcp-stdio` |
| MCP HTTP | request authentication result | `mcp-http` |

Do not create a second handler for an adapter and do not call `run` directly.
Transport parsing happens before `invoke`; business validation, authorization,
execution, output validation, errors, and events remain in the single runtime
pipeline.

Next, read the [capability authorization guide](./capability-authorization.md)
and the [v0.1 scope matrix](./scope-matrix.md).
