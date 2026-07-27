import { createEngine, defineCapability } from "@ai-engine/core";
import { z } from "zod";
import { serveMcpStdio } from "../../dist/index.js";

const mode = process.env.STDIO_LIFECYCLE_MODE;

if (mode === "pre-ended") {
  process.stdin.resume();
  if (!process.stdin.readableEnded && !process.stdin.destroyed) {
    await new Promise((resolve) => process.stdin.once("end", resolve));
  }
  if (!process.stdin.destroyed) {
    await new Promise((resolve) => process.stdin.once("close", resolve));
  }
}

if (mode === "delayed-epipe") {
  process.stdout.write = (_chunk, ...args) => {
    process.stderr.write("write-started\n");
    const callback = args.find((argument) => typeof argument === "function");
    setTimeout(() => {
      const error = Object.assign(new Error("delayed write EPIPE"), {
        code: "EPIPE",
      });
      callback?.(error);
      process.stdout.emit("error", error);
    }, 50);
    return false;
  };
}

if (mode === "backpressure") {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    if (Buffer.byteLength(chunk) > 1_000_000) {
      process.stderr.write("large-write-started\n");
    }
    return write(chunk, ...args);
  };
}

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
    "example.large": defineCapability({
      description: "Returns a response larger than the stdout pipe buffer.",
      input: z.object({}),
      output: z.object({ data: z.string() }),
      access: "public",
      async run() {
        process.stderr.write("large-result\n");
        return { data: "x".repeat(2_000_000) };
      },
    }),
    "example.concurrent-wait": defineCapability({
      description: "Waits for cancellation and identifies its request.",
      input: z.object({ label: z.string() }),
      output: z.object({ done: z.boolean() }),
      access: "public",
      async run({ input, context }) {
        process.stderr.write(`started:${input.label}\n`);
        return await new Promise((_resolve, reject) => {
          const cancel = () => {
            process.stderr.write(`cancelled:${input.label}\n`);
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
