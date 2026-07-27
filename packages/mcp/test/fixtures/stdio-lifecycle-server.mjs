import { createEngine, defineCapability } from "@ai-engine/core";
import { z } from "zod";
import { serveMcpStdio } from "../../dist/index.js";

const engine = createEngine({
  name: "stdio-lifecycle-engine",
  version: "0.1.0",
  capabilities: {
    "example.wait": defineCapability({
      description: "Waits for the stdio channel to close.",
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      access: "public",
      async run({ context }) {
        process.stderr.write("started\n");
        return await new Promise((_resolve, reject) => {
          const cancel = () => {
            process.stderr.write("cancelled\n");
            reject(context.signal.reason);
          };
          if (context.signal.aborted) cancel();
          else context.signal.addEventListener("abort", cancel, { once: true });
        });
      },
    }),
  },
});

function listenerCounts() {
  return {
    stdinEnd: process.stdin.listenerCount("end"),
    stdinClose: process.stdin.listenerCount("close"),
    stdoutError: process.stdout.listenerCount("error"),
    stdoutDrain: process.stdout.listenerCount("drain"),
  };
}

const initialListeners = listenerCounts();
await serveMcpStdio(engine);
const finalListeners = listenerCounts();
if (JSON.stringify(finalListeners) !== JSON.stringify(initialListeners)) {
  throw new Error("The stdio adapter leaked process stream listeners.");
}
process.stderr.write("listeners-clean\n");
