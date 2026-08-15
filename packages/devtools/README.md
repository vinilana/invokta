# @invokta/devtools

Invokta DevTools: a local MCP workbench, installed CLI inspection,
installation verifier, and engine diagnostics for Invokta.
The package is a binary supporting application: it contributes no capability,
runtime adapter, or alternative execution path.

## Install

Install it as a development dependency of an engine project:

```sh
yarn add --dev @invokta/devtools
```

The package is native ESM, requires Node.js 22.20.0 or later, and exposes the
`invokta-devtools` binary. `npx @invokta/devtools --help` prints the complete
usage and `npx @invokta/devtools --version` prints the installed version.

## Quickstart

Build the engine, then serve it and verify its MCP installation:

```sh
yarn build
npx @invokta/devtools serve dist/engine.js
npx @invokta/devtools verify --stdio node --arg dist/mcp-stdio.js
```

`serve` prints one ready line on standard output — `Invokta devtools
listening on http://localhost:<port>/` — and keeps the dev server running
until `SIGINT` or `SIGTERM`. The engine `name@version`, the capability count,
and the watch status accompany it on standard error. Open the printed loopback
URL to invoke capabilities from the web interface.

The interface binds loopback and answers on `localhost`, `127.0.0.1`, and
`[::1]` alike. A port already in use is not a failure: the next free port is
taken and standard error reports `port: <requested> is in use, using
<selected> instead`.

## Watch mode

`--watch` requires `--build` and runs the engine host in a replaceable child
process: project changes run the explicit build command, and only a successful
build replaces the running engine host. Modules are never reloaded in process.

```sh
npx @invokta/devtools serve dist/engine.js \
  --watch --build "tsc -p tsconfig.json --pretty false"
```

Use `--watch-include <path>` to add a path to the watched set and
`--watch-ignore <pattern>` to exclude paths from triggering a rebuild.
`--trace-capacity <n>` resizes the bounded in-memory trace buffer.

## Command reference

### Global options

- `--help` (or `-h`) prints the usage and exits.
- `--version` (or `-v`) prints the installed package version and exits.

### invokta-devtools open

```text
invokta-devtools [--mcp | --cli] [--port <number>]
invokta-devtools open [--mcp | --cli] [--port <number>]
```

Bare invocation and `open` are equivalent. Both serve the two idle workbenches
from one loopback origin and land on the chooser at `/`:

| Path | Surface |
| --- | --- |
| `/` | the chooser: which workbench to open |
| `/mcp` | the MCP workbench |
| `/cli` | the CLI workbench |

`--mcp` and `--cli` land on that workbench instead — the ready line points at
its path — and the other one stays mounted. The workbench header carries the
way back to the chooser and the switch to the other workbench, and an idle
workbench repeats both as links next to its Connect form. Neither workbench loads a workspace, spawns a target, or
opens an outbound connection until you select Connect, and each keeps its own
browser session: connecting one leaves the other idle.

```sh
npx @invokta/devtools
npx @invokta/devtools open --port 4200
npx @invokta/devtools open --mcp
npx @invokta/devtools open --cli
```

Open the printed loopback URL.

On the MCP workbench, connect either a structured stdio command or a
Streamable HTTP URL from the Connection view. The attached UI provides Tools,
Activity, and Connection validation.

In Tools, the argument editor opens on a starter object derived from the
selected tool's advertised input schema, `Format JSON` and `Reset to schema`
keep that draft workable, and `Ctrl`/`⌘` + `Enter` runs the call from the
editor. Advertised behavior hints such as `readOnlyHint` and `destructiveHint`
appear as tags above the panes, and the result bar reports the outcome and its
elapsed time. The input schema and the current result each carry a copy
control. The seed is a convenience, not a validated value; the attached server
remains the only authority on its own schema.

For an HTTP server that uses OAuth, select **OAuth**, then **Connect**. Continue
through the provider in the new tab and return to the workbench after the
loopback callback completes. Invokta uses Authorization Code with PKCE, the
server's advertised MCP OAuth metadata, and its advertised dynamic client
registration endpoint. It does not accept a preconfigured client ID or client
secret. The authorization servers the resource's own Protected Resource
Metadata advertises are followed, including ones on another origin — which is
what every hosted identity provider is. That document is still read only from
the resource's own origin, so the resource stays the authority on who may issue
tokens for it, and a loopback HTTP authorization server is accepted only behind
a loopback HTTP resource. Tokens, PKCE material, client registration data, and
discovery documents remain in process memory and are cleared on disconnect or
process exit.

OAuth is intentionally interactive and UI-only. The `verify` command supports
none, bearer, and custom-header authentication so it remains deterministic for
automation and homologation pipelines.

### invokta-devtools open --cli

```text
invokta-devtools --cli [--port <number>]
invokta-devtools open --cli [--port <number>]
```

`--cli` lands on the idle CLI workbench. It does not load a workspace, spawn a
process, or import a module until you select Connect. Switching to the MCP
workbench from the header is a link between two pages: it carries no target,
connection, or activity across, and it leaves this workbench attached to
whatever it had. There is no `verify --cli` command.

Connect exactly one structured descriptor: an executable, an argument array,
an optional working directory, and environment names and values. Connect runs
`<command> <args...> list` once with `shell: false` and waits for the child
to exit. Selecting a capability runs `describe <id>`. Run is enabled only
after a successful list and describe, and only when you press Run:

```text
<command> <args...> run <id> --input '<json>'
```

The workbench never passes `--stdin`, `--format`, actor flags, or login
flags. Each verb starts a new process and that process exits. DevTools does
not supply a principal; the attached CLI remains the composition root.

The CLI UI provides Commands, Activity, and Connection validation. Activity
records the verb, capability id, exit code, duration, and outcome only. It
does not store argv, environment values, or stream bodies.

```sh
npx @invokta/devtools open --cli
npx @invokta/devtools open --cli --port 4200
```

### invokta-devtools verify

```text
invokta-devtools verify --stdio <executable> [--arg <value>]...
  [--cwd <directory>] [--env <child-name>=<source-environment-name>]...
invokta-devtools verify --http <url> [--auth <none|bearer|headers>]
  [--bearer-env <environment-name>]
  [--header-env <header-name>=<environment-name>]...
```

`verify` performs initialization and the complete paginated `tools/list` only.
It never calls a tool. Exit `0` means validation passed, `1` means the target or
protocol failed, and `2` means the command or target descriptor is invalid.
Usage errors name the specific cause, and a missing environment value names the
variable.

Additional options:

- `--json` writes the verification report as JSON to standard output.
- `--timeout-ms <ms>` overrides the verification deadline; an expired deadline
  fails with `TIMEOUT`.
- `--max-tools <n>` bounds the paginated `tools/list`; a target that advertises
  more tools fails verification.

#### Verify a local stdio installation

This verifies the built `hello-engine` example through the same executable and
argument shape an MCP client would use:

```sh
npx @invokta/devtools verify \
  --stdio node \
  --arg examples/hello-engine/dist/mcp-stdio.js
```

Repeat `--arg` for additional arguments. Use `--cwd <directory>` to select the
child working directory and `--env CHILD_NAME=SOURCE_ENV_NAME` to copy an
already-set environment value into the child. The command is spawned without a
shell.

#### Verify Streamable HTTP without authentication

Start the target separately, then point verification at its exact endpoint:

```sh
npx @invokta/devtools verify \
  --http http://127.0.0.1:3000/mcp \
  --auth none
```

HTTP is accepted only for literal loopback addresses. Other targets require
HTTPS.

#### Verify Streamable HTTP with a bearer token

For a local smoke test, start the built `hello-engine` HTTP adapter in one
terminal:

```sh
HELLO_ENGINE_DEMO_TOKEN=local-dev-token \
  node examples/hello-engine/dist/mcp-http.js
```

Verify it from another terminal. The CLI argument names the environment
variable; the token value is not an argument:

```sh
HELLO_ENGINE_DEMO_TOKEN=local-dev-token \
  npx @invokta/devtools verify \
    --http http://127.0.0.1:3000/mcp \
    --auth bearer \
    --bearer-env HELLO_ENGINE_DEMO_TOKEN
```

#### Verify Streamable HTTP with custom headers

Set each value in the environment and map its header name explicitly. Repeat
`--header-env` when the installation requires more than one header.

```sh
MCP_API_KEY=local-dev-key \
  npx @invokta/devtools verify \
    --http https://mcp.example.com/mcp \
    --auth headers \
    --header-env X-API-Key=MCP_API_KEY
```

### invokta-devtools doctor

```text
invokta-devtools doctor <esm-module> [--export <name>] [--json]
```

Read-only development checks for a built engine module.

- `<esm-module>` is resolved against the current working directory and must
  already be built to ESM. Importing the module executes it.
- `--export <name>` selects the export to inspect. It defaults to `engine`,
  the documented composition-root convention.
- `--json` writes the report as JSON to standard output.

The doctor verifies that the export is an engine, reads every capability
summary and description, and checks that the published JSON Schemas are
readable. Missing titles or annotations and the presence of the
`invokta.mcp.json` manifest are reported as advisory notes. The doctor never
invokes a capability, starts a transport, or mutates the filesystem.

#### Exit codes

| Exit | Meaning |
| ---: | --- |
| `0` | The engine passed the checks; notes may be reported |
| `1` | The doctor reported findings |
| `2` | Invalid usage, a load failure, a missing export, or a non-engine export |

Diagnostics are deterministic, stack-free, and written only to `stderr`.

### invokta-devtools serve

```text
invokta-devtools serve <esm-module> [--export <name>] [--port <number>]
  [--engine-port <number>] [--watch --build <command>]
  [--watch-include <path>] [--watch-ignore <pattern>]
  [--trace-capacity <n>]
```

The workspace-aware mode for a built Invokta engine. Unlike attached
inspection, it can run a capability through every adapter the engine
publishes, show Doctor, offer test identities backed by development
`Principal` values, keep the Invokta invocation trace, and apply watch
behavior, because it owns the engine module.

```sh
npx @invokta/devtools doctor \
  examples/hello-engine/dist/engine.js

npx @invokta/devtools serve \
  examples/hello-engine/dist/engine.js
```

`<esm-module>` is resolved against the current working directory and must
already be built to native ESM. `--export <name>` defaults to `engine`.

Standard output carries exactly one ready line, `Invokta devtools listening on
http://localhost:<port>/`; the engine `name@version`, the capability count,
and the watch status are written to standard error with the other diagnostics.
Exit `0` means the dev server shut down cleanly, `1` means the doctor
preflight reported findings or the server could not start, and `2` means
invalid usage, a module that failed to load, a missing export, or a non-engine
export.

The built-engine interface uses one compact workbench surface across
Capabilities, Activity, Diagnostics, and Test identities. Capabilities
summarizes top-level input and output fields for scanning and keeps each
complete JSON Schema available under **Raw JSON Schema**. Invocations use the
schema-seeded JSON editor and always reach `engine.invoke`.

### Adapters

Capabilities runs one capability call through the execution path you select, so
the same arguments can be compared across every path the engine publishes:

| Adapter | What runs | `ExecutionContext.source` |
| --- | --- | --- |
| **Direct** | `engine.invoke`, the way an embedding application calls it | `direct` |
| **CLI** | the `@invokta/cli` adapter as a process, with its exit code and streams | `cli` |
| **MCP stdio** | the `serveMcpStdio` server, called the way an MCP client calls it | `mcp-stdio` |
| **MCP HTTP** | one Streamable HTTP request to the running engine host | `mcp-http` |

Every emulation performs a real call through the published adapter. Direct,
CLI, and MCP stdio each run in a child process that imports the same built
module you passed to `serve`, started per call and ended with it; MCP HTTP
reuses the running engine host. The result bar reads the same for every
adapter, and **Adapter exchange** shows what that path actually carried — the
bodies and HTTP status, the `tools/call` frames, or the command with its
streams and exit code. A capability error arrives with the same code from all
four paths.

Direct and CLI carry the arguments in the command line, so a payload beyond
what the operating system allows in one argument is refused with
`ARGUMENTS_TOO_LARGE`; the MCP adapters carry the same payload in the protocol.

### Identity and authentication

The adapter bar separates the two, because the framework does:

**Identity** is the development `Principal` the call acts as. It applies to
every adapter — it is what an `access` rule sees — and includes an explicit
**Anonymous** choice so a rule can be denied on purpose. The three process
adapters start as the selected identity, the way a composition root supplies
it; there is no credential and no authentication step, so nothing else is
asked of you.

**Entry** appears for CLI and MCP stdio, and decides which composition root
runs the call:

| Entry point | Who supplies the principal |
| --- | --- |
| **Devtools** (default) | the identity selected here, so an `access` rule can be exercised as different actors |
| **Project** | your own built entry point, spawned as it is — its root decides, including `principal: null`, which is what the generated starter passes |

Selecting your entry point is how you see what the shipped command actually
does: the identity control turns off and says so, and the reproduction command
becomes the command you would type. Name the path yourself — the devtools
proposes the conventional sibling of the served module and discovers nothing —
and it must stay inside the directory `serve` runs in. A direct call has no
project entry point: a generated `src/direct.ts` is a demonstration script
bound to one capability, not an adapter with an invocation contract.

**Authentication** appears only for MCP HTTP, which is the only path that
authenticates. It selects where the call goes and how it presents itself:

| Target | Authentication |
| --- | --- |
| **Devtools host** (default) | the selected identity's session token, or no credential — which exercises the adapter's own fail-closed `401` |
| **External endpoint** | none, bearer, custom headers, or interactive OAuth |

An external endpoint is a Streamable HTTP MCP URL you run yourself, typically
your own built HTTP entry point, so the authentication you actually ship — the
hook in `src/http-auth.ts` — runs against the same arguments the other three
paths use. The principal then comes from *that server's* hook, not from the
devtools identity. Plain HTTP is accepted only for loopback; every other
endpoint must use HTTPS.

With **OAuth** selected, **Check** runs the discovery chain against the endpoint
and reports it leg by leg: the `401` challenge and whether it advertises
`resource_metadata`, the Protected Resource Metadata document, the Authorization
Server's RFC 8414 metadata, and whether dynamic client registration is
advertised. A leg that could not run says what it was waiting for rather than
reporting a failure it never attempted, and **Authorize** stays disabled until
the chain resolves. The check authorizes nothing and sends no credential.

An Authorization Server on a different origin than the engine — which is what
every hosted identity provider is — is reached as long as the engine's own
Protected Resource Metadata advertises it. That document is still read only
from the engine's own origin, so the engine remains the authority on who may
issue tokens for it.

A credential value starting with `$` names an environment variable the dev
server reads, so the secret stays in the dev server's environment instead of
travelling through the browser. Whatever you supply is held in process memory
for as long as the endpoint stays selected: it is never persisted, never
written to your project, and never echoed back — reading the selection returns
the URL, the authentication type, and header or variable names only.

The arguments, result, adapter command, raw MCP request, raw MCP response, and
each JSON Schema carry a copy control. `Ctrl`/`⌘` + `Enter` invokes from the
editor, and `/` returns focus to the capability filter from anywhere outside a
text field.

Activity adds a toolbar: filter entries by text across capability IDs,
adapters, MCP methods, HTTP status, and captured payloads; narrow the feed to
emulated calls, invocations, MCP exchanges, or lifecycle notices; and **Hold**
stops new entries from arriving while you read one, releasing the held entries
as soon as you resume. Filtering and holding act on the browser view only.

**Clear view** is different: it empties the visible list *and* the dev
server's in-memory buffer, so the entries do not come back on the next
reconnect. The trace stays a session-scoped in-memory aid — there is no export
route, and nothing is written to disk.

## Troubleshooting

- **The module could not be loaded, or the export is missing.** The module
  path is resolved against the current working directory and must already be
  built to native ESM; the error message suggests building first. Run the
  project build (for example `yarn build`) and retry.
- **The interface answered on a port you did not ask for.** The requested
  port was in use, so the next free one was taken; standard error names both.
  Pin a port with `--port`, for example
  `npx @invokta/devtools serve dist/engine.js --port 4200` — that port is
  taken too if it is free, and walks on from there if it is not.
- **`verify` fails with `TIMEOUT`.** The verification deadline expired before
  initialization or the paginated `tools/list` completed. Raise it with
  `--timeout-ms <ms>`.
- **The `--http` URL requires HTTPS.** Plain HTTP is accepted only for the
  literal loopback addresses `http://127.0.0.1` and `http://[::1]`; every
  other target must use HTTPS.
- **`INVALID_TARGET` with `--env` or `--header-env`.** The mapping shape is
  `CHILD=SOURCE` for `--env` and `HEADER=SOURCE` for `--header-env`: the left
  side is the name the child process or the request sees, and the right side
  names the environment variable in this shell that provides the value. A
  missing value fails with `ENVIRONMENT_VALUE_MISSING` and names the variable.

## Test from this repository

From the repository root, install and build all workspaces first:

```sh
yarn install --frozen-lockfile
yarn build
```

The examples above invoke the published binary. When testing changes from this
repository, replace `npx @invokta/devtools` with the locally built binary:

```sh
node packages/devtools/dist/cli.js serve examples/hello-engine/dist/engine.js
```

The built-engine contract is chartered by
[ADR 0021](../../docs/adr/0021-engine-devtools-dev-server.md), extended for
adapter emulation by
[ADR 0028](../../docs/adr/0028-adapter-emulation-in-engine-devtools.md).
Installed-target inspection is chartered by
[ADR 0022](../../docs/adr/0022-mcp-installation-inspection-and-homologation.md),
with interactive OAuth accepted by
[ADR 0023](../../docs/adr/0023-ephemeral-oauth-for-installed-mcp-inspection.md).
Installed CLI inspection is chartered by
[ADR 0032](../../docs/adr/0032-cli-installation-inspection-and-homologation.md).
