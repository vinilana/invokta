import { pathToFileURL } from "node:url";

import { createFirecrawlCrawlEngine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

const defaultUrl = "https://example.com/";

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const engine = createFirecrawlCrawlEngine();
  const result = await engine.invoke(
    "crawl.scrape-page",
    { url: args[0] ?? defaultUrl },
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
    process.stderr.write("Crawl engine direct invocation failed.\n");
    process.exitCode = 1;
  });
}
