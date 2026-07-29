import { defineCapability } from "@invokta/core";
import { z } from "zod";

import type { ImageEditor } from "../application/ports.js";
import {
  aspectRatioSchema,
  generativeAnnotations,
  promptSchema,
  referenceImageSchema,
  singleImageOutputSchema,
} from "./image-contract.js";

export function createEditAsset(editor: ImageEditor) {
  return defineCapability({
    title: "Edit image asset",
    description:
      "Edit an existing visual while preserving the supplied image details.",
    input: z.object({
      prompt: promptSchema,
      referenceImages: z.array(referenceImageSchema).min(1).max(4),
      aspectRatio: aspectRatioSchema,
    }),
    output: singleImageOutputSchema,
    access: "authenticated",
    timeoutMs: 150_000,
    annotations: generativeAnnotations,
    async run({ input, context }) {
      return {
        image: await editor.edit(input, { signal: context.signal }),
      };
    },
  });
}
