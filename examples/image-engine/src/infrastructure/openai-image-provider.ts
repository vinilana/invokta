import type {
  ImageAsset,
  ImageEditor,
  ReferenceImage,
  TextImageRenderer,
} from "../application/ports.js";
import type { AspectRatio } from "../domain/image.js";
import {
  imageFileExtension,
  isBoundedBase64,
  maximumGeneratedImageBytes,
} from "../domain/image.js";
import {
  asRecord,
  providerEndpoint,
  providerFailure,
  requestProviderJson,
} from "./provider-http.js";

export interface OpenAiImageProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface OpenAiImageProvider extends ImageEditor, TextImageRenderer {}

const defaultBaseUrl = "https://api.openai.com/v1";
const defaultModel = "gpt-image-2";

const sizes: Readonly<Record<AspectRatio, string>> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "16:9": "1792x1008",
  "9:16": "1008x1792",
};

function readOpenAiImage(payload: unknown): ImageAsset {
  const record = asRecord(payload);
  const data = record?.data;
  const first = Array.isArray(data) ? asRecord(data[0]) : null;
  const base64Data = first?.b64_json;
  if (
    typeof base64Data !== "string" ||
    !isBoundedBase64(base64Data, maximumGeneratedImageBytes)
  ) {
    throw providerFailure("OpenAI returned no image.", { provider: "openai" });
  }
  return { mimeType: "image/png", base64Data };
}

function toBlob(reference: ReferenceImage): Blob {
  const bytes = Uint8Array.from(Buffer.from(reference.base64Data, "base64"));
  return new Blob([bytes], { type: reference.mimeType });
}

export function createOpenAiImageProvider(
  options: OpenAiImageProviderOptions,
): OpenAiImageProvider {
  const apiKey = options.apiKey;
  const model = options.model ?? defaultModel;
  if (apiKey === "") throw new TypeError("An OpenAI API key is required.");
  if (model === "") throw new TypeError("An OpenAI image model is required.");
  const baseUrl = options.baseUrl ?? defaultBaseUrl;
  const generationsUrl = providerEndpoint(baseUrl, "images/generations");
  const editsUrl = providerEndpoint(baseUrl, "images/edits");
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  const request = async (
    url: URL,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<ImageAsset> =>
    readOpenAiImage(
      await requestProviderJson({
        provider: "openai",
        providerLabel: "OpenAI",
        url,
        init,
        fetch: fetchImplementation,
        signal,
        requestFailureMessage:
          "The OpenAI image request could not be completed.",
        rejectionMessage: "OpenAI rejected the image request.",
      }),
    );

  return {
    async render({ prompt, requiredText, aspectRatio }, { signal }) {
      return request(
        generationsUrl,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            prompt: `${prompt}\n\nRender this text exactly as written, without adding or changing characters: "${requiredText}"`,
            size: sizes[aspectRatio],
            quality: "high",
            output_format: "png",
            n: 1,
          }),
        },
        signal,
      );
    },

    async edit({ prompt, referenceImages, aspectRatio }, { signal }) {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", prompt);
      form.set("size", sizes[aspectRatio]);
      form.set("quality", "high");
      form.set("output_format", "png");
      referenceImages.forEach((reference, index) => {
        form.append(
          "image[]",
          toBlob(reference),
          `reference-${String(index + 1)}.${imageFileExtension(reference.mimeType)}`,
        );
      });
      return request(
        editsUrl,
        {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body: form,
        },
        signal,
      );
    },
  };
}
