import type { Principal, ProgressReport } from "@invokta/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ImageAsset,
  ImageEngineDependencies,
} from "../src/application/ports.js";
import { providerProgressIntervalMs } from "../src/capabilities/provider-progress-contract.js";
import { createImageEngine } from "../src/engine.js";

const principal: Principal = { id: "agent:creative-director" };
const generatedImage: ImageAsset = {
  mimeType: "image/png",
  base64Data: Buffer.from("generated png").toString("base64"),
};
const referenceImage = {
  mimeType: "image/png",
  base64Data: Buffer.from("reference png").toString("base64"),
} as const;

function deferredDependencies() {
  const series = Promise.withResolvers<ReadonlyArray<ImageAsset>>();
  const single = Promise.withResolvers<ImageAsset>();
  const dependencies: ImageEngineDependencies = {
    editor: { edit: vi.fn(() => single.promise) },
    textRenderer: { render: vi.fn(() => single.promise) },
    campaignGenerator: { generateSeries: vi.fn(() => series.promise) },
    referenceComposer: { compose: vi.fn(() => single.promise) },
  };
  return { dependencies, series, single };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("image engine progress", () => {
  it("reports liveness while a long campaign request is pending", async () => {
    vi.useFakeTimers();
    const { dependencies, series } = deferredDependencies();
    const engine = createImageEngine(dependencies);
    const reports: ProgressReport[] = [];

    const pending = engine.invoke(
      "image.generate-campaign-series",
      { prompt: "A coherent launch series.", count: 2 },
      { principal, onProgress: (report) => void reports.push(report) },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toEqual([
      { progress: 0, message: "Generating 2 campaign images." },
    ]);

    await vi.advanceTimersByTimeAsync(2 * providerProgressIntervalMs);
    expect(reports.map(({ progress }) => progress)).toEqual([0, 15, 30]);

    series.resolve([generatedImage, generatedImage]);
    await expect(pending).resolves.toEqual({
      images: [generatedImage, generatedImage],
    });
    await vi.advanceTimersByTimeAsync(4 * providerProgressIntervalMs);
    expect(reports).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [
      "image.edit-asset",
      { prompt: "Change the background.", referenceImages: [referenceImage] },
      "Editing the image asset.",
    ],
    [
      "image.render-text-asset",
      { prompt: "A restrained poster.", requiredText: "SHIP IT" },
      "Rendering the text image asset.",
    ],
    [
      "image.compose-reference-asset",
      {
        prompt: "Compose a new product scene.",
        referenceImages: [referenceImage, referenceImage],
      },
      "Composing the reference image asset.",
    ],
  ] as const)(
    "stops reporting %s progress when the provider request fails",
    async (capabilityId, input, message) => {
      vi.useFakeTimers();
      const { dependencies, single } = deferredDependencies();
      const engine = createImageEngine(dependencies);
      const reports: ProgressReport[] = [];

      const pending = engine.invoke(capabilityId, input as never, {
        principal,
        onProgress: (report) => void reports.push(report),
      });
      await vi.advanceTimersByTimeAsync(providerProgressIntervalMs);
      single.reject(new Error("provider unavailable"));

      await expect(pending).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
      await vi.advanceTimersByTimeAsync(4 * providerProgressIntervalMs);
      expect(reports).toEqual([
        { progress: 0, message },
        { progress: 15, message },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
