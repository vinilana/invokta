# Obsidian Context Engine

This example publishes one read-only capability that turns a local Obsidian
vault into bounded Markdown context for an application or MCP client:

| Capability | Purpose |
| --- | --- |
| `obsidian.provide-context` | Rank Markdown notes for a query and return context with vault-relative source paths |

The capability is defined once. Direct calls, the CLI, MCP stdio, and stateless
MCP HTTP all execute it through `engine.invoke`.

## Architecture

```text
direct / CLI / MCP stdio / MCP HTTP
                |
                v
           engine.invoke
                |
                v
      obsidian.provide-context
                |
                v
      VaultContextProvider port
                |
                v
   local read-only filesystem adapter
```

The `VaultContextProvider` port keeps retrieval replaceable. The bundled adapter
walks Markdown files, normalizes accents and case, ranks phrase and term matches,
and assembles deterministic excerpts. It does not require an embedding model, a
vector database, or an external account.

## Configure and build

Point the process at the vault or at a narrower folder inside it. A narrower
folder is useful when an MCP client should not receive context from every note.

```sh
export OBSIDIAN_VAULT_PATH='/absolute/path/to/your/vault'
yarn workspace @ai-engine/example-obsidian-context build
yarn workspace @ai-engine/example-obsidian-context test
```

The adapter reads `.md` files only. It ignores every `.obsidian` directory and
all symbolic links, does not modify the vault, and returns only relative source
paths. The configured absolute path never enters the capability input, output,
events, or normal diagnostics.

## Invoke directly or through the CLI

```sh
node examples/obsidian-context-engine/dist/direct.js agent architecture

node examples/obsidian-context-engine/dist/cli.js list
node examples/obsidian-context-engine/dist/cli.js describe obsidian.provide-context
node examples/obsidian-context-engine/dist/cli.js run obsidian.provide-context \
  --input '{"query":"agent architecture","maxNotes":3}'
```

The result is structured for both an application and an agent:

```json
{
  "query": "agent architecture",
  "context": "## Agent design\nSource: architecture/agent-design.md\n\nUse explicit contracts...",
  "sources": [
    {
      "path": "architecture/agent-design.md",
      "title": "Agent design"
    }
  ],
  "truncated": false
}
```

An authenticated caller is required. The direct, CLI, and MCP stdio composition
roots provide a trusted local principal; identity is never accepted through the
query input.

## Use as a local MCP server

Start the process with `node` so a package-manager wrapper cannot write status
text to the MCP protocol stream:

```sh
OBSIDIAN_VAULT_PATH='/absolute/path/to/your/vault' \
  node examples/obsidian-context-engine/dist/mcp-stdio.js
```

A generic MCP host configuration looks like this after the example is built:

```json
{
  "mcpServers": {
    "obsidian-context": {
      "command": "node",
      "args": [
        "/absolute/path/to/ai-engines/examples/obsidian-context-engine/dist/mcp-stdio.js"
      ],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

The MCP tool name is `obsidian.provide-context`.

## Run stateless MCP HTTP

The HTTP example binds to loopback by default and requires a bearer token:

```sh
OBSIDIAN_VAULT_PATH='/absolute/path/to/your/vault' \
OBSIDIAN_ENGINE_BEARER_TOKEN='development-only-token' \
PORT=3000 \
  node examples/obsidian-context-engine/dist/mcp-http.js
```

The endpoint is `http://127.0.0.1:3000/mcp`. The literal token comparison is a
deterministic authentication-hook demonstration, not production authentication.
Replace it with the host organization's identity integration before deployment.

## Operational bounds

| Dimension | Bound |
| --- | --- |
| Query | 1–500 characters and at least one letter or number |
| Returned notes | Default 5; request range 1–10 |
| Returned context | 20,000 characters |
| Excerpt per matching note | 1,200 characters before final assembly |
| Markdown files scanned | 10,000 |
| Filesystem entries visited | 50,000 |
| Individual note size | 1 MiB; larger notes are skipped |
| Total candidate bytes | 50 MiB |
| Capability timeout | 15 seconds |

`truncated` is `true` when additional matches exist, the context character limit
clips a section, or an oversized note was skipped. Exceeding a vault-wide scan
limit fails deterministically with `EXECUTION_FAILED`. Cancellation is checked
throughout traversal and reading.

This adapter scans on every invocation, which keeps the example small and its
results current. A production engine can replace the port with an indexed or
semantic implementation without changing the capability or any entrypoint.
