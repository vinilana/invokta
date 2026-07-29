import { pathToFileURL } from "node:url";

import { createDefaultAgentSessionEngine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

export async function main(): Promise<void> {
  const sessionId = process.argv[2] ?? "agent-session-demo";
  const engine = createDefaultAgentSessionEngine();
  const invocation = { source: "direct", principal: localPrincipal } as const;
  await engine.invoke(
    "agent-session.start",
    {
      sessionId,
      objective: "Demonstrate a portable agent session.",
      workspaceRoot: process.cwd(),
    },
    invocation,
  );
  const created = await engine.invoke(
    "agent-session.create-task",
    {
      sessionId,
      taskId: "verify-handoff",
      title: "Verify that another harness can resume the session",
      phase: "validation",
      assignedHarness: "codex",
      assignedAgentId: "direct-demo-agent",
    },
    invocation,
  );
  const checkpointed = await engine.invoke(
    "agent-session.checkpoint",
    {
      sessionId,
      expectedRevision: created.sessionRevision,
      phase: "validation",
      status: "paused",
      checkpoint: "The portable task was created from the direct adapter.",
      nextAction: "Resume this session from a configured harness.",
    },
    invocation,
  );
  process.stdout.write(`${JSON.stringify(checkpointed, null, 2)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch(() => {
    process.stderr.write("Agent session direct example failed.\n");
    process.exitCode = 1;
  });
}
