import type {
  CampaignImageGenerator,
  ImageAsset,
} from "../application/ports.js";
import {
  isBoundedBase64,
  maximumGeneratedImageBytes,
} from "../domain/image.js";
import {
  asRecord,
  providerEndpoint,
  providerFailure,
  requestProviderJson,
} from "./provider-http.js";

export interface SeedreamCampaignGeneratorOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetch?: typeof globalThis.fetch;
}

const defaultBaseUrl = "https://ark.ap-southeast.bytepluses.com/api/v3";
const defaultModel = "seedream-5-0-260128";

function readImages(payload: unknown): ReadonlyArray<ImageAsset> {
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const base64Data = asRecord(entry)?.b64_json;
    return typeof base64Data === "string" &&
      isBoundedBase64(base64Data, maximumGeneratedImageBytes)
      ? [{ mimeType: "image/png" as const, base64Data }]
      : [];
  });
}

export function createSeedreamCampaignGenerator(
  options: SeedreamCampaignGeneratorOptions,
): CampaignImageGenerator {
  const apiKey = options.apiKey;
  const model = options.model ?? defaultModel;
  if (apiKey === "")
    throw new TypeError("A BytePlus ModelArk API key is required.");
  if (model === "") throw new TypeError("A Seedream image model is required.");
  const endpoint = providerEndpoint(
    options.baseUrl ?? defaultBaseUrl,
    "images/generations",
  );
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    async generateSeries(
      { prompt, count, aspectRatio, resolution },
      { signal },
    ) {
      const payload = await requestProviderJson({
        provider: "seedream",
        providerLabel: "Seedream",
        url: endpoint,
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            prompt: `${prompt}\n\nGenerate exactly ${String(count)} visually coherent campaign images at a ${aspectRatio} aspect ratio. Preserve the same art direction, subjects, products, and brand cues across the complete series.`,
            size: resolution,
            output_format: "png",
            response_format: "b64_json",
            watermark: false,
            sequential_image_generation: "auto",
            sequential_image_generation_options: { max_images: count },
          }),
        },
        fetch: fetchImplementation,
        signal,
        requestFailureMessage:
          "The Seedream image request could not be completed.",
        rejectionMessage: "Seedream rejected the image request.",
      });
      const images = readImages(payload);
      if (images.length !== count) {
        throw providerFailure(
          "Seedream returned an incomplete campaign series.",
          {
            provider: "seedream",
            expectedImages: count,
            receivedImages: images.length,
          },
        );
      }
      return images;
    },
  };
}
