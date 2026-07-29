export const imageMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type ImageMimeType = (typeof imageMimeTypes)[number];

export const aspectRatios = ["1:1", "3:2", "2:3", "16:9", "9:16"] as const;

export type AspectRatio = (typeof aspectRatios)[number];

export const imageResolutions = ["2K", "4K"] as const;

export type ImageResolution = (typeof imageResolutions)[number];

export const maximumReferenceImageBytes = 10 * 1024 * 1024;
export const maximumGeneratedImageBytes = 32 * 1024 * 1024;

const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function isBoundedBase64(value: string, maximumBytes: number): boolean {
  if (value === "" || !base64Pattern.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  return decodedBytes <= maximumBytes;
}

export function imageFileExtension(mimeType: ImageMimeType): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
  }
}
