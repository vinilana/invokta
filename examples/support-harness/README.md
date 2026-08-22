# Support Harness

This private example is a consumer of the support engine, not a fourth framework
package. It starts the existing support engine MCP stdio process with the
official MCP client, discovers `support_classify-ticket`, calls it once, and
records its own message and tool-execution history. The engine keeps
`support.classify-ticket` as its domain capability ID.

The harness does not import the engine, capability, core runtime, or MCP server
adapter. It does not contain an autonomous loop: the requested ticket maps to one
tool call and then execution stops.

From the repository root:

```sh
yarn workspace @invokta/example-support build
yarn workspace @invokta/example-support-harness build
node examples/support-harness/dist/main.js T-123
```

The support engine child process reserves stdout for MCP protocol messages. The
harness prints only its final JSON snapshot to its own stdout.

## Verify the engine before consuming it

```sh
yarn workspace @invokta/example-support-harness devtools:verify
```

`invokta-devtools verify` runs initialization and the complete paginated
`tools/list` against the same `node dist/mcp-stdio.js` command this harness
spawns, and never calls a tool. It exits `0` when the engine is installable as
an MCP server and `1` when the target or protocol fails, so it is the
deterministic check to run before the harness itself.
