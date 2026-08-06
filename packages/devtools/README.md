# @invokta/devtools

Local MCP workbench, installation verifier, and engine diagnostics for Invokta.
The package is a binary supporting application: it contributes no capability,
runtime adapter, or alternative execution path.

## Test from this repository

From the repository root, install and build all workspaces first:

```sh
yarn install --frozen-lockfile
yarn build
```

The examples below run the locally built binary directly. When using the
published package, replace `node packages/devtools/dist/cli.js` with
`npx invokta-devtools`.

### Open the installed-MCP workbench

Bare invocation and `open` are equivalent. Both start an idle loopback UI and
do not load a workspace, spawn a target, or open an outbound connection until
you select Connect.

```sh
node packages/devtools/dist/cli.js
node packages/devtools/dist/cli.js open --port 4200
```

Open the printed loopback URL. Connect either a structured stdio command or a
Streamable HTTP URL from the Connection view. The attached UI provides Tools,
Activity, and Connection validation.

For an HTTP server that uses OAuth, select **OAuth**, then **Connect**. Continue
through the provider in the new tab and return to the workbench after the
loopback callback completes. Invokta uses Authorization Code with PKCE, the
server's advertised MCP OAuth metadata, and its advertised dynamic client
registration endpoint. It does not accept a preconfigured client ID or client
secret. OAuth endpoints must remain on the MCP resource's exact origin; a
cross-origin identity provider is rejected. Tokens, PKCE material, client
registration data, and discovery documents remain in process memory and are
cleared on disconnect or process exit.

OAuth is intentionally interactive and UI-only. The `verify` command supports
none, bearer, and custom-header authentication so it remains deterministic for
automation and homologation pipelines.

### Verify a local stdio installation

This verifies the built `hello-engine` example through the same executable and
argument shape an MCP client would use:

```sh
node packages/devtools/dist/cli.js verify \
  --stdio node \
  --arg examples/hello-engine/dist/mcp-stdio.js
```

Repeat `--arg` for additional arguments. Use `--cwd <directory>` to select the
child working directory and `--env CHILD_NAME=SOURCE_ENV_NAME` to copy an
already-set environment value into the child. The command is spawned without a
shell.

### Verify Streamable HTTP without authentication

Start the target separately, then point verification at its exact endpoint:

```sh
node packages/devtools/dist/cli.js verify \
  --http http://127.0.0.1:3000/mcp \
  --auth none
```

HTTP is accepted only for literal loopback addresses. Other targets require
HTTPS.

### Verify Streamable HTTP with a bearer token

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
  node packages/devtools/dist/cli.js verify \
    --http http://127.0.0.1:3000/mcp \
    --auth bearer \
    --bearer-env HELLO_ENGINE_DEMO_TOKEN
```

### Verify Streamable HTTP with custom headers

Set each value in the environment and map its header name explicitly. Repeat
`--header-env` when the installation requires more than one header.

```sh
MCP_API_KEY=local-dev-key \
  node packages/devtools/dist/cli.js verify \
    --http https://mcp.example.com/mcp \
    --auth headers \
    --header-env X-API-Key=MCP_API_KEY
```

`verify` performs initialization and the complete paginated `tools/list` only.
It never calls a tool. Exit `0` means validation passed, `1` means the target or
protocol failed, and `2` means the command or target descriptor is invalid.

## Existing built-engine serve mode

The existing workspace-aware mode remains available for a built Invokta engine.
Unlike attached inspection, it can show Doctor, test identities backed by
development `Principal` values, Invokta invocation trace, and watch behavior
because it owns the engine host.

```sh
node packages/devtools/dist/cli.js doctor \
  examples/hello-engine/dist/engine.js

node packages/devtools/dist/cli.js serve \
  examples/hello-engine/dist/engine.js
```

`<esm-module>` is resolved against the current working directory and must
already be built to native ESM. `--export <name>` defaults to `engine`.

## invokta-devtools doctor

```text
invokta-devtools doctor <esm-module> [--export <name>]
```

Read-only development checks for a built engine module.

- `<esm-module>` is resolved against the current working directory and must
  already be built to ESM. Importing the module executes it.
- `--export <name>` selects the export to inspect. It defaults to `engine`,
  the documented composition-root convention.

The doctor verifies that the export is an engine, reads every capability
summary and description, and checks that the published JSON Schemas are
readable. Missing titles or annotations and the presence of the
`invokta.mcp.json` manifest are reported as advisory notes. The doctor never
invokes a capability, starts a transport, or mutates the filesystem.

### Exit codes

| Exit | Meaning |
| ---: | --- |
| `0` | The engine passed the checks; notes may be reported |
| `1` | The doctor reported findings |
| `2` | Invalid usage, a load failure, a missing export, or a non-engine export |

Diagnostics are deterministic, stack-free, and written only to `stderr`.

The built-engine contract is specified in the
[engine devtools dev server specification](../../docs/specs/engine-devtools-dev-server.md)
and chartered by [ADR 0020](../../docs/adr/0020-engine-devtools-dev-server.md).
Installed-target inspection is specified in the
[MCP installation inspection and homologation specification](../../docs/specs/mcp-installation-inspection-and-homologation.md)
and chartered by
[ADR 0021](../../docs/adr/0021-mcp-installation-inspection-and-homologation.md),
with interactive OAuth accepted by
[ADR 0022](../../docs/adr/0022-ephemeral-oauth-for-installed-mcp-inspection.md).
