# Inspect a local repository with Sem

This recipe uses the existing `@invokta/mcp` client facade (ADR 0022) to call
[Sem](https://github.com/Ataraxy-Labs/sem), without creating an Action Engine or
changing any capability contract. Install Sem first and ensure `sem` is on PATH.

After installing and building Invokta, save the following as
`sem-lookup.mjs` in the repository root and run:

```sh
node sem-lookup.mjs /absolute/path/to/git-checkout parse_config
```

```js
import { resolve } from "node:path";
import { connectMcpClient } from "@invokta/mcp";

const [repo, query] = process.argv.slice(2);
if (!repo || !query) throw new Error("Usage: node sem-lookup.mjs <repo> <symbol>");
const signal = AbortSignal.timeout(60_000);
const connection = await connectMcpClient(
  {
    transport: "stdio",
    command: "sem",
    args: ["mcp"],
    cwd: resolve(repo),
    env: {
      SEM_REPO: resolve(repo),
      SEM_LOCAL: "1",
      SEM_MCP_NO_SHARED: "1",
      SEM_NO_NETWORK: "1",
      SEM_NO_TELEMETRY: "1",
    },
  },
  { signal },
);
try {
  const result = await connection.callTool("sem_find", { query }, { signal });
  console.log(JSON.stringify(result.response, null, 2));
  if (result.response.isError) process.exitCode = 1;
} finally {
  await connection.close();
}
```

No model credentials or model call are involved. The client starts the selected
executable directly; the repository path is a structured argument, not shell
text. Only `sem_find` is invoked. Sem's stdio server also advertises other tools,
including command-running tools; this recipe does not grant a model access to
them. Sem may create local indexes. Its environment controls are not an OS
sandbox. Printed source must be approved for any downstream model or log sink.

For entity edits, the same facade can connect to `weave-mcp` with
`WEAVE_REPO` set to the same checkout and `args: []`, after installing
[Weave](https://github.com/Ataraxy-Labs/weave). `weave_edit` accepts an `edits`
array and `dry_run: true` to preview it. Removing that flag writes files, and its
optional `then` argument executes a shell command. Introduce those capabilities
only behind your application's explicit policy; the lookup recipe does neither.

A transport connection is not an Invokta authorization rule. If wrapping these
operations in a capability, keep authorization and execution on `engine.invoke`
and expose only the actions the product intends to own.
