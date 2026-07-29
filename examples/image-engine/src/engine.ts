import { createEngine } from "@ai-engine/core";

import type { ImageEngineDependencies } from "./application/ports.js";
import { createComposeReferenceAsset } from "./capabilities/compose-reference-asset.js";
import { createEditAsset } from "./capabilities/edit-asset.js";
import { createGenerateCampaignSeries } from "./capabilities/generate-campaign-series.js";
import { createRenderTextAsset } from "./capabilities/render-text-asset.js";
import { createNanoBananaReferenceComposer } from "./infrastructure/nano-banana-reference-composer.js";
import { createOpenAiImageProvider } from "./infrastructure/openai-image-provider.js";
import { createSeedreamCampaignGenerator } from "./infrastructure/seedream-campaign-generator.js";

export function createImageEngine(dependencies: ImageEngineDependencies) {
  return createEngine({
    name: "multi-provider-image-engine",
    version: "0.1.0",
    capabilities: {
      "image.edit-asset": createEditAsset(dependencies.editor),
      "image.render-text-asset": createRenderTextAsset(
        dependencies.textRenderer,
      ),
      "image.generate-campaign-series": createGenerateCampaignSeries(
        dependencies.campaignGenerator,
      ),
      "image.compose-reference-asset": createComposeReferenceAsset(
        dependencies.referenceComposer,
      ),
    },
  });
}

export interface ImageEngineEnvironment {
  readonly OPENAI_API_KEY?: string | undefined;
  readonly OPENAI_BASE_URL?: string | undefined;
  readonly OPENAI_IMAGE_MODEL?: string | undefined;
  readonly ARK_API_KEY?: string | undefined;
  readonly BYTEPLUS_ARK_BASE_URL?: string | undefined;
  readonly SEEDREAM_IMAGE_MODEL?: string | undefined;
  readonly GEMINI_API_KEY?: string | undefined;
  readonly GEMINI_BASE_URL?: string | undefined;
  readonly NANO_BANANA_IMAGE_MODEL?: string | undefined;
}

function requiredCredential(
  environment: ImageEngineEnvironment,
  name: "OPENAI_API_KEY" | "ARK_API_KEY" | "GEMINI_API_KEY",
): string {
  const value = environment[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalValue(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Composition root for the three outbound providers. Credentials and model IDs
 * never enter a capability input or result.
 */
export function createConfiguredImageEngine(
  environment: ImageEngineEnvironment = process.env,
) {
  const openAiBaseUrl = optionalValue(environment.OPENAI_BASE_URL);
  const openAiModel = optionalValue(environment.OPENAI_IMAGE_MODEL);
  const seedreamBaseUrl = optionalValue(environment.BYTEPLUS_ARK_BASE_URL);
  const seedreamModel = optionalValue(environment.SEEDREAM_IMAGE_MODEL);
  const geminiBaseUrl = optionalValue(environment.GEMINI_BASE_URL);
  const nanoBananaModel = optionalValue(environment.NANO_BANANA_IMAGE_MODEL);
  const openAi = createOpenAiImageProvider({
    apiKey: requiredCredential(environment, "OPENAI_API_KEY"),
    ...(openAiBaseUrl === undefined ? {} : { baseUrl: openAiBaseUrl }),
    ...(openAiModel === undefined ? {} : { model: openAiModel }),
  });
  return createImageEngine({
    editor: openAi,
    textRenderer: openAi,
    campaignGenerator: createSeedreamCampaignGenerator({
      apiKey: requiredCredential(environment, "ARK_API_KEY"),
      ...(seedreamBaseUrl === undefined ? {} : { baseUrl: seedreamBaseUrl }),
      ...(seedreamModel === undefined ? {} : { model: seedreamModel }),
    }),
    referenceComposer: createNanoBananaReferenceComposer({
      apiKey: requiredCredential(environment, "GEMINI_API_KEY"),
      ...(geminiBaseUrl === undefined ? {} : { baseUrl: geminiBaseUrl }),
      ...(nanoBananaModel === undefined ? {} : { model: nanoBananaModel }),
    }),
  });
}
