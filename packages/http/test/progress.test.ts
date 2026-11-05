import {
  createEngine,
  defineCapability,
  type ExecutionContext,
} from "@invokta/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createHttpHandler } from "../src/index.js";

describe("progress over the plain HTTP adapter", () => {
  it("treats reportProgress as a no-op and answers with the JSON result", async () => {
    const contexts: ExecutionContext[] = [];
    const engine = createEngine({
      name: "http-progress-engine",
      version: "0.1.0",
      capabilities: {
        "media.render": defineCapability({
          description: "Reports progress while rendering.",
          input: z.object({ frames: z.number().int().min(1).max(10) }),
          output: z.object({ rendered: z.number() }),
          access: "public",
          async run({ input, context }) {
            contexts.push(context);
            for (let frame = 1; frame <= input.frames; frame += 1) {
              context.reportProgress({
                progress: frame,
                total: input.frames,
                message: `Rendered frame ${String(frame)}.`,
              });
            }
            return { rendered: input.frames };
          },
        }),
      },
    });
    const handler = createHttpHandler(engine, {
      auth: { mode: "dangerously-disabled-for-development" },
    });

    const response = await handler(
      new Request("http://localhost:3000/capabilities/media.render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ frames: 3 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"rendered":3}');
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.source).toBe("http");
    expect(typeof contexts[0]?.reportProgress).toBe("function");
  });
});
