import { runParallelCommand } from "./parallel-search.js";

try {
  const response = await runParallelCommand(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (response.isError === true) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Parallel search failed."}\n`,
  );
  process.exitCode = 1;
}
