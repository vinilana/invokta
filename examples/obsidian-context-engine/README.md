# Obsidian Context Engine

This example exposes a local Obsidian vault as a bounded knowledge graph. An
agent first discovers explicitly declared context roots, opens one node, and then
decides which related node to open next.

| Capability | Purpose |
| --- | --- |
| `knowledge.list-context-roots` | List the vault's explicitly declared entrypoint indexes with their frontmatter |
| `knowledge.open-context-node` | Open one node with paged content, frontmatter, related index context, and outgoing wikilinks |

Both capabilities are defined once. Direct calls, the CLI, MCP stdio, and
stateless MCP HTTP all execute them through `engine.invoke`.

## Progressive navigation

```text
list context roots
        |
        v
choose a stable node ID
        |
        v
open content + frontmatter + one relation level
        |
        v
follow an outgoing node ID and repeat
```

This avoids text ranking and does not return the entire vault in one invocation.
The `VaultKnowledgeGraph` port keeps Obsidian-specific parsing replaceable by an
indexed database or another knowledge source without changing either capability.

## Frontmatter contract

Every navigable note has a stable `id`:

```yaml
---
id: capability-contracts
kind: guide
title: Capability contracts
status: published
indexes:
  - architecture
  - ai-engines
---
```

An entrypoint is an index explicitly marked as a root:

```yaml
---
id: architecture
kind: index
entrypoint: true
title: Architecture
summary: Architecture decisions and system boundaries
topics:
  - architecture
  - agents
---
```

The filesystem adapter applies these rules:

- `id` is the public identity and must match
  `[A-Za-z0-9][A-Za-z0-9._:/-]*` with at most 200 characters;
- only `kind: index` notes with `entrypoint: true` appear as context roots;
- `indexes` declares the index IDs related to a node, in frontmatter order;
- Obsidian `[[wikilinks]]` produce navigable outgoing links, in document order;
- wikilinks do not define index hierarchy and backlinks are not expanded;
- notes without an `id` are ordinary vault content and are ignored;
- duplicate IDs fail deterministically instead of selecting an arbitrary note;
- cycles are allowed because opening a node expands only one relation level.

By default, only these frontmatter properties can cross the engine boundary:

```text
id, kind, entrypoint, title, summary, status,
project, topics, updated, indexes
```

`FilesystemObsidianVaultOptions.exposedFrontmatterKeys` can replace that allowlist
at the trusted composition root. The tool input cannot request additional
properties.

## Configure and build

Point the process at the vault or a narrower folder inside it:

```sh
export OBSIDIAN_VAULT_PATH='/absolute/path/to/your/vault'
yarn workspace @ai-engine/example-obsidian-context build
yarn workspace @ai-engine/example-obsidian-context test
```

The adapter reads `.md` files only. It ignores every `.obsidian` directory and
all symbolic links, does not modify the vault, and returns only relative source
paths. The configured absolute path never enters capability inputs, outputs,
events, or normal diagnostics.

## Invoke directly

With no argument, the direct entrypoint lists roots:

```sh
node examples/obsidian-context-engine/dist/direct.js
```

Pass one stable ID to open a node:

```sh
node examples/obsidian-context-engine/dist/direct.js capability-contracts
```

## Use the CLI

```sh
node examples/obsidian-context-engine/dist/cli.js list
node examples/obsidian-context-engine/dist/cli.js describe knowledge.list-context-roots
node examples/obsidian-context-engine/dist/cli.js describe knowledge.open-context-node

node examples/obsidian-context-engine/dist/cli.js run \
  knowledge.list-context-roots --input '{}'

node examples/obsidian-context-engine/dist/cli.js run \
  knowledge.open-context-node \
  --input '{"id":"capability-contracts"}'
```

Opening a node returns its own frontmatter and content, the frontmatter of its
resolved indexes, and summaries for resolved outgoing wikilinks:

```json
{
  "found": true,
  "node": {
    "id": "capability-contracts",
    "title": "Capability contracts",
    "path": "guides/capability-contracts.md",
    "frontmatter": {
      "id": "capability-contracts",
      "kind": "guide",
      "indexes": ["architecture"]
    },
    "content": "# Capability contracts\n\nUse explicit contracts...",
    "contentOffset": 0,
    "contentLength": 1280,
    "contentTruncated": false
  },
  "relatedIndexes": [
    {
      "id": "architecture",
      "title": "Architecture",
      "path": "indexes/architecture.md",
      "frontmatter": {
        "id": "architecture",
        "kind": "index",
        "entrypoint": true
      }
    }
  ],
  "outgoingLinks": [],
  "unresolvedLinks": [],
  "unresolvedIndexes": [],
  "invalidNodeCount": 0,
  "relationsTruncated": false
}
```

An unknown stable ID is an expected discovery outcome and returns `found: false`.
It does not use `CAPABILITY_NOT_FOUND`, which remains reserved for an unknown
capability.

For a long note, request another content page with the same ID:

```json
{
  "id": "capability-contracts",
  "contentOffset": 20000,
  "maxContentCharacters": 10000
}
```

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

The local direct, CLI, and MCP stdio composition roots provide a trusted
principal. Identity never comes from tool input.

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
| Context roots returned | 50 |
| Content per open call | Default and maximum 20,000 characters |
| Related indexes returned | 20 |
| Outgoing wikilinks returned | 50 |
| Exposed frontmatter | 8,192 serialized characters per node |
| Frontmatter properties | 64 per object, depth 4, arrays of 100 values |
| Markdown files scanned | 10,000 |
| Filesystem entries visited | 50,000 |
| Individual note size | 1 MiB |
| Total candidate bytes | 50 MiB |
| Capability timeout | 15 seconds |

`truncated` reports additional context roots. `contentTruncated` reports that
another content page remains, and `relationsTruncated` reports additional index
or wikilink relations. Malformed frontmatter and oversized Markdown notes
contribute to `invalidNodeCount`. Exceeding a vault-wide scan limit, unreadable
UTF-8, or duplicate stable IDs fails as `EXECUTION_FAILED`. Cancellation is
checked during traversal and reading.

The adapter rebuilds its bounded view on every invocation, so calls reflect the
current filesystem without introducing framework lifecycle or cache concepts.
