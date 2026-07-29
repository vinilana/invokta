import { pathToFileURL } from "node:url";

import { createConfiguredImageEngine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

const defaultPrompt =
  "A restrained product launch poster with generous whitespace.";
const defaultText = "SHIP THE RIGHT THING";

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const engine = createConfiguredImageEngine();
  const result = await engine.invoke(
    "image.render-text-asset",
    {
      prompt: args[0] ?? defaultPrompt,
      requiredText: args[1] ?? defaultText,
    },
    { source: "direct", principal: localPrincipal },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch(() => {
    process.stderr.write("Image engine direct invocation failed.\n");
    process.exitCode = 1;
  });
}
