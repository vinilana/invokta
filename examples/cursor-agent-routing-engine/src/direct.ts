import { pathToFileURL } from "node:url";

import type { CursorUseCase } from "./domain/routing.js";
import { engine } from "./engine.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const useCase = (args[0] ?? "plan") as CursorUseCase;
  const result = await engine.invoke(
    "developer-work.route-cursor-task",
    { useCase },
    { source: "direct" },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main();
}
