import type { Principal } from "@ai-engine/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  ImageAsset,
  ImageEngineDependencies,
  ReferenceImage,
} from "../src/application/ports.js";
import {
  createConfiguredImageEngine,
  createImageEngine,
} from "../src/engine.js";

const principal: Principal = { id: "agent:creative-director" };
const pngData = Buffer.from("generated png").toString("base64");
const referenceData = Buffer.from("reference png").toString("base64");

const generatedImage: ImageAsset = {
  mimeType: "image/png",
  base64Data: pngData,
};

const referenceImage: ReferenceImage = {
  mimeType: "image/png",
  base64Data: referenceData,
};

function createDependencies(): ImageEngineDependencies {
  return {
    editor: {
      edit: vi.fn(async () => generatedImage),
    },
    textRenderer: {
      render: vi.fn(async () => generatedImage),
    },
    campaignGenerator: {
      generateSeries: vi.fn(async ({ count }) =>
        Array.from({ length: count }, () => generatedImage),
      ),
    },
    referenceComposer: {
      compose: vi.fn(async () => generatedImage),
    },
  };
}

describe("the multi-provider image engine", () => {
  it("routes existing-image edits exclusively to GPT Image 2", async () => {
    const dependencies = createDependencies();
    const engine = createImageEngine(dependencies);

    const result = await engine.invoke(
      "image.edit-asset",
      {
        prompt: "Replace the background with a quiet studio.",
        referenceImages: [referenceImage],
        aspectRatio: "3:2",
      },
      { source: "direct", principal },
    );

    expectTypeOf(result.image.base64Data).toEqualTypeOf<string>();
    expect(result).toEqual({ image: generatedImage });
    expect(dependencies.editor.edit).toHaveBeenCalledExactlyOnceWith(
      {
        prompt: "Replace the background with a quiet studio.",
        referenceImages: [referenceImage],
        aspectRatio: "3:2",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(dependencies.textRenderer.render).not.toHaveBeenCalled();
    expect(
      dependencies.campaignGenerator.generateSeries,
    ).not.toHaveBeenCalled();
    expect(dependencies.referenceComposer.compose).not.toHaveBeenCalled();
  });

  it("routes assets with exact marketing copy exclusively to GPT Image 2", async () => {
    const dependencies = createDependencies();
    const engine = createImageEngine(dependencies);

    const result = await engine.invoke(
      "image.render-text-asset",
      {
        prompt: "A restrained launch poster with generous whitespace.",
        requiredText: "SHIP THE RIGHT THING",
      },
      { source: "direct", principal },
    );

    expect(result).toEqual({ image: generatedImage });
    expect(dependencies.textRenderer.render).toHaveBeenCalledExactlyOnceWith(
      {
        prompt: "A restrained launch poster with generous whitespace.",
        requiredText: "SHIP THE RIGHT THING",
        aspectRatio: "1:1",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(dependencies.editor.edit).not.toHaveBeenCalled();
    expect(
      dependencies.campaignGenerator.generateSeries,
    ).not.toHaveBeenCalled();
    expect(dependencies.referenceComposer.compose).not.toHaveBeenCalled();
  });

  it("routes coherent campaign series exclusively to Seedream 5.0", async () => {
    const dependencies = createDependencies();
    const engine = createImageEngine(dependencies);

    const result = await engine.invoke(
      "image.generate-campaign-series",
      {
        prompt:
          "Three connected editorial scenes following one product launch.",
        count: 3,
        aspectRatio: "16:9",
        resolution: "4K",
      },
      { source: "direct", principal },
    );

    expect(result.images).toHaveLength(3);
    expect(
      dependencies.campaignGenerator.generateSeries,
    ).toHaveBeenCalledExactlyOnceWith(
      {
        prompt:
          "Three connected editorial scenes following one product launch.",
        count: 3,
        aspectRatio: "16:9",
        resolution: "4K",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(dependencies.editor.edit).not.toHaveBeenCalled();
    expect(dependencies.textRenderer.render).not.toHaveBeenCalled();
    expect(dependencies.referenceComposer.compose).not.toHaveBeenCalled();
  });

  it("routes multi-reference compositions exclusively to the latest Nano Banana", async () => {
    const dependencies = createDependencies();
    const engine = createImageEngine(dependencies);

    const result = await engine.invoke(
      "image.compose-reference-asset",
      {
        prompt: "Create a new scene that preserves both products exactly.",
        referenceImages: [
          referenceImage,
          { ...referenceImage, mimeType: "image/jpeg" },
        ],
        aspectRatio: "9:16",
        resolution: "2K",
      },
      { source: "direct", principal },
    );

    expect(result).toEqual({ image: generatedImage });
    expect(
      dependencies.referenceComposer.compose,
    ).toHaveBeenCalledExactlyOnceWith(
      {
        prompt: "Create a new scene that preserves both products exactly.",
        referenceImages: [
          referenceImage,
          { ...referenceImage, mimeType: "image/jpeg" },
        ],
        aspectRatio: "9:16",
        resolution: "2K",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(dependencies.editor.edit).not.toHaveBeenCalled();
    expect(dependencies.textRenderer.render).not.toHaveBeenCalled();
    expect(
      dependencies.campaignGenerator.generateSeries,
    ).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an edit without a reference image",
      "image.edit-asset",
      { prompt: "Change the background.", referenceImages: [] },
    ],
    [
      "a reference composition with only one image",
      "image.compose-reference-asset",
      { prompt: "Combine references.", referenceImages: [referenceImage] },
    ],
    [
      "a malformed base64 image",
      "image.edit-asset",
      {
        prompt: "Change the background.",
        referenceImages: [{ mimeType: "image/png", base64Data: "not base64" }],
      },
    ],
    [
      "more than four campaign images",
      "image.generate-campaign-series",
      { prompt: "A connected series.", count: 5 },
    ],
  ])(
    "rejects %s before any provider call",
    async (_label, capabilityId, input) => {
      const dependencies = createDependencies();
      const engine = createImageEngine(dependencies);

      await expect(
        engine.invoke(capabilityId as never, input as never, {
          source: "direct",
          principal,
        }),
      ).rejects.toMatchObject({ code: "INPUT_INVALID" });
      expect(dependencies.editor.edit).not.toHaveBeenCalled();
      expect(dependencies.textRenderer.render).not.toHaveBeenCalled();
      expect(
        dependencies.campaignGenerator.generateSeries,
      ).not.toHaveBeenCalled();
      expect(dependencies.referenceComposer.compose).not.toHaveBeenCalled();
    },
  );

  it("requires a trusted principal before any provider call", async () => {
    const dependencies = createDependencies();
    const engine = createImageEngine(dependencies);

    await expect(
      engine.invoke("image.render-text-asset", {
        prompt: "A poster.",
        requiredText: "Hello",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(dependencies.textRenderer.render).not.toHaveBeenCalled();
  });

  it("rejects provider output outside the public image contract", async () => {
    const dependencies = createDependencies();
    dependencies.textRenderer.render = vi.fn(async () => ({
      mimeType: "image/png" as const,
      base64Data: "not base64",
    }));
    const engine = createImageEngine(dependencies);

    await expect(
      engine.invoke(
        "image.render-text-asset",
        { prompt: "A poster.", requiredText: "Hello" },
        { source: "direct", principal },
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
  });

  it("propagates cancellation to the selected provider", async () => {
    const dependencies = createDependencies();
    let providerSignal: AbortSignal | undefined;
    dependencies.textRenderer.render = vi.fn(async (_request, { signal }) => {
      providerSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return generatedImage;
    });
    const engine = createImageEngine(dependencies);
    const controller = new AbortController();

    const invocation = engine.invoke(
      "image.render-text-asset",
      { prompt: "A poster.", requiredText: "Hello" },
      { source: "direct", principal, signal: controller.signal },
    );
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    controller.abort(new Error("Creative request cancelled."));

    await expect(invocation).rejects.toMatchObject({ code: "CANCELLED" });
    expect(providerSignal?.aborted).toBe(true);
  });

  it("publishes bounded authenticated domain capabilities", () => {
    const engine = createImageEngine(createDependencies());

    expect(engine.list().map(({ id }) => id)).toEqual([
      "image.edit-asset",
      "image.render-text-asset",
      "image.generate-campaign-series",
      "image.compose-reference-asset",
    ]);
    expect(engine.describe("image.edit-asset")).toMatchObject({
      title: "Edit image asset",
      timeoutMs: 150_000,
      annotations: { openWorld: true, destructive: false },
      inputSchema: {
        type: "object",
        required: ["prompt", "referenceImages"],
      },
      outputSchema: { type: "object", required: ["image"] },
    });
    expect(engine.describe("image.generate-campaign-series")).toMatchObject({
      timeoutMs: 180_000,
      annotations: { idempotent: false, openWorld: true },
    });
  });

  it("fails fast until every published provider has a credential", () => {
    expect(() => createConfiguredImageEngine({})).toThrow(
      "OPENAI_API_KEY is required.",
    );
    expect(() =>
      createConfiguredImageEngine({ OPENAI_API_KEY: "openai-key" }),
    ).toThrow("ARK_API_KEY is required.");
    expect(() =>
      createConfiguredImageEngine({
        OPENAI_API_KEY: "openai-key",
        ARK_API_KEY: "ark-key",
      }),
    ).toThrow("GEMINI_API_KEY is required.");
  });
});
