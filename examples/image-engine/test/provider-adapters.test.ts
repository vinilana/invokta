import type { EngineError } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";

import type { ReferenceImage } from "../src/application/ports.js";
import { createNanoBananaReferenceComposer } from "../src/infrastructure/nano-banana-reference-composer.js";
import { createOpenAiImageProvider } from "../src/infrastructure/openai-image-provider.js";
import { createSeedreamCampaignGenerator } from "../src/infrastructure/seedream-campaign-generator.js";

const generatedData = Buffer.from("generated png").toString("base64");
const referenceData = Buffer.from("reference png").toString("base64");
const referenceImage: ReferenceImage = {
  mimeType: "image/png",
  base64Data: referenceData,
};
const signal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("the OpenAI GPT Image 2 adapter", () => {
  it("uses the generations endpoint for high-fidelity text assets", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async (_input, _init) =>
        jsonResponse({ data: [{ b64_json: generatedData }] }),
    );
    const provider = createOpenAiImageProvider({
      apiKey: "openai-test-key",
      fetch: fetchImplementation,
    });

    const image = await provider.render(
      {
        prompt: "A restrained launch poster.",
        requiredText: "SHIP THE RIGHT THING",
        aspectRatio: "16:9",
      },
      { signal },
    );

    expect(image).toEqual({ mimeType: "image/png", base64Data: generatedData });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.openai.com/v1/images/generations");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer openai-test-key",
      "content-type": "application/json",
    });
    expect(init?.signal).toBe(signal);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-image-2",
      prompt:
        'A restrained launch poster.\n\nRender this text exactly as written, without adding or changing characters: "SHIP THE RIGHT THING"',
      size: "1792x1008",
      quality: "high",
      output_format: "png",
      n: 1,
    });
  });

  it("uses the multipart edits endpoint and preserves every reference", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async (_input, _init) =>
        jsonResponse({ data: [{ b64_json: generatedData }] }),
    );
    const provider = createOpenAiImageProvider({
      apiKey: "openai-test-key",
      fetch: fetchImplementation,
    });

    const image = await provider.edit(
      {
        prompt: "Replace the background.",
        referenceImages: [
          referenceImage,
          { ...referenceImage, mimeType: "image/jpeg" },
        ],
        aspectRatio: "3:2",
      },
      { signal },
    );

    expect(image).toEqual({ mimeType: "image/png", base64Data: generatedData });
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.openai.com/v1/images/edits");
    expect(init?.headers).toEqual({ authorization: "Bearer openai-test-key" });
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("Replace the background.");
    expect(form.get("size")).toBe("1536x1024");
    expect(form.get("quality")).toBe("high");
    expect(form.get("output_format")).toBe("png");
    expect(form.getAll("image[]")).toHaveLength(2);
    expect(form.getAll("image[]").map((entry) => (entry as File).type)).toEqual(
      ["image/png", "image/jpeg"],
    );
  });

  it("normalizes provider rejection without exposing the credential", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({ error: { message: "quota exceeded" } }, 429),
    );
    const provider = createOpenAiImageProvider({
      apiKey: "secret-openai-key",
      fetch: fetchImplementation,
    });

    const failure = await provider
      .render(
        {
          prompt: "A poster.",
          requiredText: "Hello",
          aspectRatio: "1:1",
        },
        { signal },
      )
      .then(
        () => undefined,
        (error: unknown) => error as EngineError,
      );

    expect(failure).toMatchObject({
      code: "EXECUTION_FAILED",
      message: "OpenAI rejected the image request.",
      publicDetails: { provider: "openai", status: 429 },
    });
    expect(JSON.stringify(failure)).not.toContain("secret-openai-key");
  });

  it("rejects a declared response above the 64 MiB provider limit", async () => {
    const provider = createOpenAiImageProvider({
      apiKey: "openai-test-key",
      fetch: vi.fn(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(64 * 1024 * 1024 + 1) },
          }),
      ),
    });

    await expect(
      provider.render(
        {
          prompt: "A poster.",
          requiredText: "Hello",
          aspectRatio: "1:1",
        },
        { signal },
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "OpenAI returned an unreadable response.",
      publicDetails: { provider: "openai" },
    });
  });
});

describe("the BytePlus Seedream 5.0 adapter", () => {
  it("requests a bounded coherent high-resolution campaign series", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async (_input, _init) =>
        jsonResponse({
          data: [
            { b64_json: generatedData },
            { b64_json: generatedData },
            { b64_json: generatedData },
          ],
        }),
    );
    const generator = createSeedreamCampaignGenerator({
      apiKey: "seedream-test-key",
      fetch: fetchImplementation,
    });

    const images = await generator.generateSeries(
      {
        prompt: "A connected editorial launch campaign.",
        count: 3,
        aspectRatio: "16:9",
        resolution: "4K",
      },
      { signal },
    );

    expect(images).toHaveLength(3);
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations",
    );
    expect(init?.headers).toMatchObject({
      authorization: "Bearer seedream-test-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "seedream-5-0-260128",
      prompt:
        "A connected editorial launch campaign.\n\nGenerate exactly 3 visually coherent campaign images at a 16:9 aspect ratio. Preserve the same art direction, subjects, products, and brand cues across the complete series.",
      size: "4K",
      output_format: "png",
      response_format: "b64_json",
      watermark: false,
      sequential_image_generation: "auto",
      sequential_image_generation_options: { max_images: 3 },
    });
  });

  it("fails when Seedream returns fewer images than requested", async () => {
    const generator = createSeedreamCampaignGenerator({
      apiKey: "seedream-test-key",
      fetch: vi.fn(async () =>
        jsonResponse({ data: [{ b64_json: generatedData }] }),
      ),
    });

    await expect(
      generator.generateSeries(
        {
          prompt: "A connected campaign.",
          count: 3,
          aspectRatio: "1:1",
          resolution: "2K",
        },
        { signal },
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Seedream returned an incomplete campaign series.",
      publicDetails: {
        provider: "seedream",
        expectedImages: 3,
        receivedImages: 1,
      },
    });
  });
});

describe("the Google Nano Banana 2 adapter", () => {
  it("uses the latest stable model for multi-reference composition", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async (_input, _init) =>
        jsonResponse({
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [
                { type: "text", text: "Created the composition." },
                {
                  type: "image",
                  mime_type: "image/png",
                  data: generatedData,
                },
              ],
            },
          ],
        }),
    );
    const composer = createNanoBananaReferenceComposer({
      apiKey: "gemini-test-key",
      fetch: fetchImplementation,
    });

    const image = await composer.compose(
      {
        prompt: "Create a new scene that preserves both products.",
        referenceImages: [
          referenceImage,
          { ...referenceImage, mimeType: "image/webp" },
        ],
        aspectRatio: "9:16",
        resolution: "2K",
      },
      { signal },
    );

    expect(image).toEqual({ mimeType: "image/png", base64Data: generatedData });
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    );
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      "x-goog-api-key": "gemini-test-key",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gemini-3.1-flash-image",
      input: [
        {
          type: "text",
          text: "Create a new scene that preserves both products.",
        },
        { type: "image", mime_type: "image/png", data: referenceData },
        { type: "image", mime_type: "image/webp", data: referenceData },
      ],
      response_format: {
        type: "image",
        mime_type: "image/png",
        aspect_ratio: "9:16",
        image_size: "2K",
        delivery: "inline",
      },
    });
  });

  it("rejects a completed interaction without an inline image", async () => {
    const composer = createNanoBananaReferenceComposer({
      apiKey: "gemini-test-key",
      fetch: vi.fn(async () =>
        jsonResponse({
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [{ type: "text", text: "No image available." }],
            },
          ],
        }),
      ),
    });

    await expect(
      composer.compose(
        {
          prompt: "Compose these references.",
          referenceImages: [referenceImage, referenceImage],
          aspectRatio: "1:1",
          resolution: "2K",
        },
        { signal },
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Nano Banana returned no image.",
      publicDetails: { provider: "google" },
    });
  });
});
