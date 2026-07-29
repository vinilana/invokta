import { defineCapability } from "@invokta/core";
import { z } from "zod";

import type { ReferenceImageComposer } from "../application/ports.js";
import {
  aspectRatioSchema,
  generativeAnnotations,
  promptSchema,
  referenceImageSchema,
  resolutionSchema,
  singleImageOutputSchema,
} from "./image-contracts.js";

export function createComposeReferenceAsset(composer: ReferenceImageComposer) {
  return defineCapability({
    title: "Compose reference image asset",
    description:
      "Create a new visual composition while preserving subjects from multiple references.",
    input: z.object({
      prompt: promptSchema,
      referenceImages: z.array(referenceImageSchema).min(2).max(4),
      aspectRatio: aspectRatioSchema,
      resolution: resolutionSchema,
    }),
    output: singleImageOutputSchema,
    access: "authenticated",
    timeoutMs: 150_000,
    annotations: generativeAnnotations,
    async run({ input, context }) {
      return {
        image: await composer.compose(input, { signal: context.signal }),
      };
    },
  });
}
