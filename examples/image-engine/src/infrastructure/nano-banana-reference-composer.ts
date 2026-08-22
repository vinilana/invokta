import { defineConnector } from "@invokta/core";
import { z } from "zod";

import type {
  ImageAsset,
  ReferenceImageComposer,
} from "../application/ports.js";
import type { ImageMimeType } from "../domain/image.js";
import {
  imageMimeTypes,
  isBoundedBase64,
  maximumGeneratedImageBytes,
} from "../domain/image.js";
import {
  asRecord,
  isCredentialFreeHttpUrl,
  providerEndpoint,
  providerFailure,
  requestProviderJson,
} from "./provider-http.js";

export interface NanoBananaReferenceComposerOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface NanoBananaConnectorDependencies {
  readonly fetch: typeof globalThis.fetch;
}

const nanoBananaConnectorConfig = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().refine(isCredentialFreeHttpUrl).optional(),
  model: z.string().min(1).optional(),
});

const defaultBaseUrl = "https://generativelanguage.googleapis.com/v1beta";
const defaultModel = "gemini-3.1-flash-image";

function isImageMimeType(value: unknown): value is ImageMimeType {
  return (
    typeof value === "string" &&
    imageMimeTypes.some((mimeType) => mimeType === value)
  );
}

function readLastImage(payload: unknown): ImageAsset | null {
  const steps = asRecord(payload)?.steps;
  if (!Array.isArray(steps)) return null;
  let result: ImageAsset | null = null;
  for (const step of steps) {
    const content = asRecord(step)?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const record = asRecord(item);
      const base64Data = record?.data;
      const mimeType = record?.mime_type;
      if (
        record?.type === "image" &&
        isImageMimeType(mimeType) &&
        typeof base64Data === "string" &&
        isBoundedBase64(base64Data, maximumGeneratedImageBytes)
      ) {
        result = { mimeType, base64Data };
      }
    }
  }
  return result;
}

export function createNanoBananaReferenceComposer(
  options: NanoBananaReferenceComposerOptions,
): ReferenceImageComposer {
  const apiKey = options.apiKey;
  const model = options.model ?? defaultModel;
  if (apiKey === "") throw new TypeError("A Gemini API key is required.");
  if (model === "")
    throw new TypeError("A Nano Banana image model is required.");
  const endpoint = providerEndpoint(
    options.baseUrl ?? defaultBaseUrl,
    "interactions",
  );
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    async compose(
      { prompt, referenceImages, aspectRatio, resolution },
      { signal },
    ) {
      const payload = await requestProviderJson({
        provider: "google",
        providerLabel: "Nano Banana",
        url: endpoint,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            model,
            input: [
              { type: "text", text: prompt },
              ...referenceImages.map((reference) => ({
                type: "image",
                mime_type: reference.mimeType,
                data: reference.base64Data,
              })),
            ],
            response_format: {
              type: "image",
              mime_type: "image/png",
              aspect_ratio: aspectRatio,
              image_size: resolution,
              delivery: "inline",
            },
          }),
        },
        fetch: fetchImplementation,
        signal,
        requestFailureMessage:
          "The Nano Banana image request could not be completed.",
        rejectionMessage: "Nano Banana rejected the image request.",
      });
      const image = readLastImage(payload);
      if (image === null) {
        throw providerFailure("Nano Banana returned no image.", {
          provider: "google",
        });
      }
      return image;
    },
  };
}

export const nanoBananaConnector = defineConnector({
  name: "nano-banana",
  config: nanoBananaConnectorConfig,
  create(config, dependencies: NanoBananaConnectorDependencies) {
    return {
      ports: {
        referenceComposer: createNanoBananaReferenceComposer({
          apiKey: config.apiKey,
          ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
          ...(config.model === undefined ? {} : { model: config.model }),
          fetch: dependencies.fetch,
        }),
      },
    };
  },
});
