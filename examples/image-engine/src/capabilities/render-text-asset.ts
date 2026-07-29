import { defineCapability } from "@ai-engine/core";
import { z } from "zod";

import type { TextImageRenderer } from "../application/ports.js";
import {
  aspectRatioSchema,
  generativeAnnotations,
  promptSchema,
  requiredTextSchema,
  singleImageOutputSchema,
} from "./image-contracts.js";

export function createRenderTextAsset(renderer: TextImageRenderer) {
  return defineCapability({
    title: "Render text image asset",
    description:
      "Create a visual that prioritizes faithful rendering of supplied marketing copy.",
    input: z.object({
      prompt: promptSchema,
      requiredText: requiredTextSchema,
      aspectRatio: aspectRatioSchema,
    }),
    output: singleImageOutputSchema,
    access: "authenticated",
    timeoutMs: 150_000,
    annotations: generativeAnnotations,
    async run({ input, context }) {
      return {
        image: await renderer.render(input, { signal: context.signal }),
      };
    },
  });
}
