import { EngineError, defineCapability } from "@ai-engine/core";
import { z } from "zod";

import type { CampaignImageGenerator } from "../application/ports.js";
import {
  aspectRatioSchema,
  generativeAnnotations,
  imageAssetSchema,
  promptSchema,
  resolutionSchema,
} from "./image-contracts.js";

export function createGenerateCampaignSeries(
  generator: CampaignImageGenerator,
) {
  return defineCapability({
    title: "Generate campaign image series",
    description:
      "Create two to four visually coherent campaign images with shared art direction.",
    input: z.object({
      prompt: promptSchema,
      count: z.number().int().min(2).max(4),
      aspectRatio: aspectRatioSchema,
      resolution: resolutionSchema,
    }),
    output: z.object({ images: z.array(imageAssetSchema).min(2).max(4) }),
    access: "authenticated",
    timeoutMs: 180_000,
    annotations: generativeAnnotations,
    async run({ input, context }) {
      const images = await generator.generateSeries(input, {
        signal: context.signal,
      });
      if (images.length !== input.count) {
        throw new EngineError({
          code: "EXECUTION_FAILED",
          message: "The campaign generator returned an incomplete series.",
        });
      }
      return {
        images: images.map(({ mimeType, base64Data }) => ({
          mimeType,
          base64Data,
        })),
      };
    },
  });
}
