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

function isBase64Code(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47
  );
}

/**
 * Accepts non-empty, padded RFC 4648 base64 whose decoded size is within the
 * bound. A linear character scan, rather than a regular expression, keeps
 * multi-megabyte images from exhausting the regular-expression stack.
 */
export function isBoundedBase64(value: string, maximumBytes: number): boolean {
  const length = value.length;
  if (length === 0 || length % 4 !== 0) return false;
  let end = length;
  if (value.charCodeAt(end - 1) === 61) end -= 1;
  if (value.charCodeAt(end - 1) === 61) end -= 1;
  const decodedBytes = (length / 4) * 3 - (length - end);
  if (decodedBytes > maximumBytes) return false;
  for (let index = 0; index < end; index += 1) {
    if (!isBase64Code(value.charCodeAt(index))) return false;
  }
  return true;
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
