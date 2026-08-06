# Getting started: one capability, four entry points

This guide builds a small domain capability and exposes the same implementation
through a direct call, the CLI, MCP stdio, and stateless MCP Streamable HTTP. The
examples use Zod 4, but the core accepts any schema that implements both Standard
Schema v1 and Standard JSON Schema v1.

For complete, runnable compositions, see
[`hello-engine`](../examples/hello-engine/) and
[`support-engine`](../examples/support-engine/). The hello example is the shortest
onboarding path. The support example demonstrates injected ports and a domain
authorization rule. Further examples apply the same contracts to harder cases:
[`crawl-engine`](../examples/crawl-engine/) integrates an external provider
(Firecrawl) behind a port, and [`spec-engine`](../examples/spec-engine/) runs a
multi-step, spec-driven workflow using domain stage rules. The
[`agent-session-engine`](../examples/agent-session-engine/) shows how command
hooks from Cursor, Antigravity, Claude Code, and Codex can record durable agent
session metadata through the CLI adapter while another harness resumes from a
portable checkpoint. The [`review-engine`](../examples/review-engine/) applies
code-review, acceptance-eval, and adversarial-review rules before an agent may
declare a task complete.

## Prerequisites

- Node.js 22.20.0 or later;
- Yarn 1.22.22 for this repository;
- an ESM TypeScript project;
- `@invokta/core`, and the adapter packages needed by the chosen entry points;
- a compatible schema implementation, such as Zod 4.

When working in this repository, install and build from its root:

```sh
yarn install --frozen-lockfile
yarn build
```

## 1. Define the capability once

Create `src/engine.ts`:

```ts
import { createEngine, defineCapability } from "@invokta/core";
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
  version: "1.0.0",
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
import { runCli } from "@invokta/cli";

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
import { serveMcpStdio } from "@invokta/mcp";

import { engine } from "./engine.js";

await serveMcpStdio(engine, {
  principal: { id: "local:mcp-host" },
});
```

The process that starts the server supplies the trusted local principal. Standard
output is reserved for MCP messages, so write application diagnostics only to
standard error. Under normal protocol flow, closing the client input closes the
protocol connection, cancels active capability work, and lets the server process
shut down. On POSIX, the adapter can also interrupt a pending asynchronous pipe
write during teardown. On Windows, Node writes to pipes synchronously, so the
client must continuously drain server stdout and supervise the process; a non-reading
peer can otherwise block JavaScript before the EOF handlers run. Normal MCP stdio
exchange remains supported on Windows. Run the built entry point directly with
Node to avoid package-manager status text on the protocol stream:

```sh
node examples/hello-engine/dist/mcp-stdio.js
```

Incoming stdio data uses a 10 MiB read-buffer limit by default. A host whose
capability contract requires a different finite boundary may pass a positive
safe integer as `maxReadBufferBytes`. Crossing the boundary closes the protocol
connection and rejects `serveMcpStdio`; input exactly at the boundary remains
accepted.

An MCP client will discover `onboarding.create-welcome-message` as one tool with
the capability's original input schema, output schema, description, and optional
annotations.

## 5. Add the stateless HTTP entry point

For a local-only first connection, create `src/mcp-http.ts` with the explicit
development opt-out:

```ts
import { serveMcpHttp } from "@invokta/mcp";

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

## 6. Load local environment files

Every composition root above reads its configuration from `process.env`. To
populate it during local development, put a `.env` file at the project root and
apply it from the composition root before anything else reads configuration:

```ts
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const parsed = parseEnv(readFileSync(".env", "utf8"));

for (const [key, value] of Object.entries(parsed)) {
  // The real environment always wins: only absent keys are filled.
  if (process.env[key] === undefined && value !== undefined) {
    process.env[key] = value;
  }
}
```

Three rules make this safe. Precedence is fixed — the process environment, then
the file, then the composition root's own defaults — so a forgotten local file
can never displace CI, container, or platform configuration, not even for a
variable that is present and empty. Parsing is Node's built-in `parseEnv`, so
there is no `dotenv` dependency and no dialect of your own. And a missing `.env`
is a silent no-op, while a file named explicitly by `INVOKTA_ENV_FILE` that is
missing or unreadable must fail startup rather than degrade silently.

Check required variables after loading and fail closed, listing the missing
names and never a value:

```ts
const missing = ["SUPPORT_API_TOKEN"].filter((name) => !process.env[name]);
if (missing.length > 0) {
  process.stderr.write(
    `A required environment variable is missing. (${missing.join(", ")})\n`,
  );
  process.exit(1);
}
```

Commit `.env.example`, which carries names only; never commit `.env`, and inject
production values through your platform instead.

`invokta-deploy init` from [`@invokta/deploy`](../packages/deploy/README.md)
generates a complete loader as `src/env.ts`, along with the matching
`.env.example`, and the deployment package it produces excludes every `.env*`
file from the container build context. File safety, bounds, and stable startup
failures are documented in the deployment package's
[environment-file guide](../packages/deploy/README.md#environment-files).

## 7. Verify reuse rather than duplicate it

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

## 8. Develop interactively with the devtools

`@invokta/devtools` serves a built engine module through the same MCP HTTP
adapter and opens a local web inspector:

```sh
npx invokta-devtools serve dist/engine.js
```

The interface on `http://127.0.0.1:4100/` lists every capability with its
JSON Schemas, invokes capabilities from a schema-seeded editor while showing
the raw MCP exchange, follows a live invocation trace, and switches between
minted development principals so `access` rules can be exercised as different
actors. Projects generated by `create-invokta-engine` include a `dev` script
that also rebuilds and restarts the engine on source changes. See the
[devtools reference](../apps/docs/src/content/docs/reference/devtools.mdx).

Next, read the [capability authorization guide](./capability-authorization.md)
and the [scope matrix](./scope-matrix.md).
