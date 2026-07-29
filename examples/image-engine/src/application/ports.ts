import type {
  AspectRatio,
  ImageMimeType,
  ImageResolution,
} from "../domain/image.js";

export interface ImageAsset {
  readonly mimeType: ImageMimeType;
  readonly base64Data: string;
}

export type ReferenceImage = ImageAsset;

export interface ImageProviderCallOptions {
  readonly signal: AbortSignal;
}

export interface ImageEditor {
  edit(
    request: {
      readonly prompt: string;
      readonly referenceImages: ReadonlyArray<ReferenceImage>;
      readonly aspectRatio: AspectRatio;
    },
    options: ImageProviderCallOptions,
  ): Promise<ImageAsset>;
}

export interface TextImageRenderer {
  render(
    request: {
      readonly prompt: string;
      readonly requiredText: string;
      readonly aspectRatio: AspectRatio;
    },
    options: ImageProviderCallOptions,
  ): Promise<ImageAsset>;
}

export interface CampaignImageGenerator {
  generateSeries(
    request: {
      readonly prompt: string;
      readonly count: number;
      readonly aspectRatio: AspectRatio;
      readonly resolution: ImageResolution;
    },
    options: ImageProviderCallOptions,
  ): Promise<ReadonlyArray<ImageAsset>>;
}

export interface ReferenceImageComposer {
  compose(
    request: {
      readonly prompt: string;
      readonly referenceImages: ReadonlyArray<ReferenceImage>;
      readonly aspectRatio: AspectRatio;
      readonly resolution: ImageResolution;
    },
    options: ImageProviderCallOptions,
  ): Promise<ImageAsset>;
}

export interface ImageEngineDependencies {
  readonly editor: ImageEditor;
  readonly textRenderer: TextImageRenderer;
  readonly campaignGenerator: CampaignImageGenerator;
  readonly referenceComposer: ReferenceImageComposer;
}
