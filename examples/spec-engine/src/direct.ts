import { pathToFileURL } from "node:url";

import { engine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

const invocation = { source: "direct", principal: localPrincipal } as const;

/**
 * Drives the spec-driven workflow from the outside: one `engine.invoke` per
 * step, each guarded by the domain stage rules. The framework contributes no
 * orchestration; the caller decides the order and the engine refuses any step
 * that the current stage does not allow.
 */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const specId = args[0] ?? "SPEC-DEMO";
  await engine.invoke(
    "spec.create-specification",
    {
      specId,
      intent:
        "Publish a ticket classification capability; reject a request from an unauthorized principal",
    },
    invocation,
  );
  await engine.invoke("spec.plan-implementation", { specId }, invocation);
  const tasked = await engine.invoke(
    "spec.break-down-tasks",
    { specId },
    invocation,
  );
  for (const task of tasked.tasks) {
    await engine.invoke(
      "spec.complete-task",
      {
        specId,
        taskId: task.id,
        evidence: `vitest run ${task.id.toLowerCase()}`,
      },
      invocation,
    );
  }

  const status = await engine.invoke(
    "spec.get-workflow-status",
    { specId },
    invocation,
  );
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch(() => {
    process.stderr.write("Spec engine direct invocation failed.\n");
    process.exitCode = 1;
  });
}
