# gateway-jev-engine

Let [TypeSafe's Jev](https://typesafe.ai) decide which of a vendor's 200 MCP
tools a task needs, behind a gateway that only ever shows each caller the
tools it may call.

> The API is in the
> [`@invokta/gateway` reference](https://docs.invokta.dev/reference/gateway/).

## How it works

An agent connected to `/search/mcp` sees three tools. It calls
`gateway.search-tools` with the user's whole task, for example
`"Cancel order O-42 and archive its invoice"`, and receives only the tools
that task needs, with their input schemas:

```text
task ──> search-tools ──> visible tools of the caller (gateway.visibility)
                              │
                              ▼
                 Jev: one yes/no question per tool, batched
                 "Is this tool needed to complete the task?"
                              │
                              ▼
         tools with P(yes) >= threshold, most likely first
         ["crm.billing_archive-invoice", "crm.orders_cancel-order"]
```

The agent then calls each one through `invoke-tool` or `invoke-read-tool`,
which run the target's gateway rule exactly as a direct call would.

- **Several tools per task.** Jev's `noul` primitive answers each tool
  independently with a calibrated yes-probability, so a two-step task gets
  two tools. A `choice` question would pick only one.
- **Abstention.** When no tool reaches the threshold, the result is empty and
  the agent should rephrase, instead of receiving a guess.
- **Only visible tools are judged.** A sales reader's task is judged against
  its 80 read-only tools; write tools are never sent to Jev for that caller.
- **Fail soft, never open.** If Jev fails or misses its 15-second deadline,
  the gateway answers with its deterministic lexical search. The ranker can
  only reorder or drop visible tools, never reveal one.

## The connector

[`infrastructure/typesafe-jev-judge.ts`](./src/infrastructure/typesafe-jev-judge.ts)
implements the engine-owned `ToolNeedJudge` port with `fetch`, following the
`systemOne` request and response shapes of the official
[`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk) 0.7.0:

```json
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY

{
  "model": "jev-latest",
  "state": { "task": "Cancel order O-42 and archive its invoice" },
  "questions": {
    "tool_0": {
      "type": "noul",
      "instructions": {
        "question": "Is this tool needed to complete the task?",
        "tool": { "id": "crm.orders_cancel-order", "description": "Cancel an order that has not completed." }
      },
      "criteria": {
        "true": "The task cannot be completed without calling this tool.",
        "false": "The task can be completed without this tool."
      }
    }
  }
}
```

The answer for each question is `{ "type": "noul", "noul": <P(yes)> }`. The
connector validates every probability, bounds batches (16 questions per
request), concurrency (4 requests), candidates (256), the per-request
deadline (10 s), and the response size (1 MiB), cancels in-flight batches
after a failure, and reports failures without the key or the response body.

**What was verified.** The tests drive the connector, the selector, and both
gateway endpoints against a deterministic stand-in that speaks the same HTTP
contract. The live Jev API was not called while building this example; run
`npm run select-tools` with your key to see real decisions. Batch size and
concurrency are conservative defaults; tune them to your TypeSafe account's
limits.

**Data sent to TypeSafe.** The task text, and the ID, title, and description
of each tool the caller may see. Never the caller's credentials, the gateway's
service token, tool input, or tool output.

**Cost.** One Jev request per 16 visible tools for each search: 12 requests
for a caller who sees 180 tools. For larger catalogs, shortlist candidates
first, for example with the semantic search of
[`gateway-semantic-search-engine`](../gateway-semantic-search-engine/), and let
Jev decide among the shortlist.

## Layout

```text
src/
  application/ports.ts                  # ToolNeedJudge port
  infrastructure/typesafe-jev-judge.ts  # TypeSafe Jev connector (fetch)
  selection/jev-tool-selector.ts        # threshold, ordering, rank port
  upstreams/crm-engine.ts               # the vendor's 200 tools
  crm-mcp-http.ts                       # the vendor's MCP server
  access/                               # route-aware rules, API keys
  gateway.ts                            # discovery with Jev as the ranker
  gateway-http.ts                       # /mcp and /search/mcp servers
  select-tools.ts                       # ask Jev for one task, no server
test/
  typesafe-jev-judge.test.ts            # request shape, batching, failures
  jev-tool-selector.test.ts             # selection inside the gateway
  gateway-http.test.ts                  # an MCP client end to end
  support/fake-typesafe-api.ts          # the offline stand-in
```

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | gateway, `select-tools` | Your TypeSafe API key |
| `TYPESAFE_BASE_URL` | gateway, `select-tools` | Defaults to `https://api.typesafe.ai` |
| `TYPESAFE_MODEL` | gateway, `select-tools` | Defaults to `jev-latest` |
| `JEV_THRESHOLD` | gateway, `select-tools` | Minimum P(yes) for a needed tool; defaults to `0.5` |
| `CRM_SERVICE_TOKEN` | vendor server, gateway | Token the vendor server accepts; at least 16 characters |
| `CRM_MCP_URL` | gateway | Defaults to `http://127.0.0.1:3401/mcp` |
| `CRM_CATALOG_PIN` | gateway | Optional catalog fingerprint |
| `GATEWAY_API_KEYS` | gateway | JSON array of `{ "id", "sha256", "scopes"? }` with `crm:read` or `crm:write` |

## Run it

From the repository root, build once:

```sh
yarn build
cd examples/gateway-jev-engine
```

Ask Jev which tools one task needs, without starting a server:

```sh
export TYPESAFE_API_KEY="..."
npm run -s select-tools -- "Cancel order O-42 and archive its invoice"
```

Serve the gateway: start the vendor's server in one terminal,

```sh
export CRM_SERVICE_TOKEN="$(openssl rand -hex 24)"
npm run upstream:crm
```

then, with the same `CRM_SERVICE_TOKEN` and `TYPESAFE_API_KEY`, the gateway
in another:

```sh
export OPS_KEY="$(openssl rand -hex 24)"
export GATEWAY_API_KEYS="[{\"id\":\"sales-ops\",\"sha256\":\"$(printf '%s' "$OPS_KEY" | sha256sum | cut -d' ' -f1)\",\"scopes\":[\"crm:read\",\"crm:write\"]}]"
npm run gateway
```

The full catalog is at `http://127.0.0.1:3500/mcp` and Jev-backed discovery
at `http://127.0.0.1:3502/search/mcp`; send the key in the `x-api-key`
header.

## Test

```sh
yarn vitest run examples/gateway-jev-engine
```

The tests start the vendor server, a loopback stand-in for the TypeSafe API,
and both gateway endpoints; nothing leaves the machine.
