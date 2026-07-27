# Support Harness

This private example is a consumer of the support engine, not a fourth framework
package. It starts the existing support engine MCP stdio process with the
official MCP client, discovers `support.classify-ticket`, calls it once, and
records its own message and tool-execution history.

The harness does not import the engine, capability, core runtime, or MCP server
adapter. It does not contain an autonomous loop: the requested ticket maps to one
tool call and then execution stops.

From the repository root:

```sh
yarn workspace @ai-engine/example-support build
yarn workspace @ai-engine/example-support-harness build
node examples/support-harness/dist/main.js T-123
```

The support engine child process reserves stdout for MCP protocol messages. The
harness prints only its final JSON snapshot to its own stdout.
