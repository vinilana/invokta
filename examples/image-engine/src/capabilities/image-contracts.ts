import { z } from "zod";

import {
  aspectRatios,
  imageMimeTypes,
  imageResolutions,
  isBoundedBase64,
  maximumGeneratedImageBytes,
  maximumReferenceImageBytes,
} from "../domain/image.js";

const maximumPromptCharacters = 4_000;
const maximumRequiredTextCharacters = 500;

export const promptSchema = z
  .string()
  .trim()
  .min(1)
  .max(maximumPromptCharacters);
export const aspectRatioSchema = z.enum(aspectRatios).default("1:1");
export const resolutionSchema = z.enum(imageResolutions).default("2K");

function boundedBase64Schema(maximumBytes: number) {
  return z
    .string()
    .max(Math.ceil(maximumBytes / 3) * 4)
    .refine((value) => isBoundedBase64(value, maximumBytes), {
      message: "Image data must be valid bounded base64.",
    });
}

export const referenceImageSchema = z.object({
  mimeType: z.enum(imageMimeTypes),
  base64Data: boundedBase64Schema(maximumReferenceImageBytes),
});

export const imageAssetSchema = z.object({
  mimeType: z.enum(imageMimeTypes),
  base64Data: boundedBase64Schema(maximumGeneratedImageBytes),
});

export const singleImageOutputSchema = z.object({ image: imageAssetSchema });

export const requiredTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(maximumRequiredTextCharacters);

export const generativeAnnotations = Object.freeze({
  readOnly: true,
  destructive: false,
  idempotent: false,
  openWorld: true,
});
