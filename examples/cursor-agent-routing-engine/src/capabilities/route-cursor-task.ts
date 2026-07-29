import { defineCapability } from "@invokta/core";
import { z } from "zod";

import { cursorUseCases, routeCursorTask } from "../domain/routing.js";

const modelSelection = z.object({
  displayName: z.string().min(1),
  selector: z.string().min(1),
});

export function createRouteCursorTask() {
  return defineCapability({
    title: "Route Cursor development work",
    description:
      "Select a versioned Cursor subagent and model configuration for a development use case.",
    input: z.object({ useCase: z.enum(cursorUseCases) }),
    output: z.object({
      catalogDate: z.literal("2026-07-28"),
      useCase: z.enum(cursorUseCases),
      agent: z.object({
        name: z.string().min(1),
        invocation: z.string().startsWith("/"),
        readOnly: z.boolean(),
      }),
      primaryModel: modelSelection,
      fallbackModel: modelSelection,
      rationale: z.string().min(1),
      instructions: z.string().min(1),
    }),
    access: "public",
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input }) {
      return routeCursorTask(input.useCase);
    },
  });
}
