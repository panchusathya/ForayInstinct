import { decode as decodePng } from "fast-png";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";

/** Longest edge kept for fill-loop vision frames. */
export const VISION_SCREENSHOT_MAX_WIDTH = 768;
/** JPEG quality for those frames. Review/approval captures stay PNG. */
const VISION_JPEG_QUALITY = 45;

interface RgbaImage {
  data: Uint8Array;
  height: number;
  width: number;
}

/**
 * Downscale a PNG or JPEG screenshot and re-encode as JPEG so each computer
 * action adds tens of kilobytes, not a raw 1280×720 PNG, to the worker prompt.
 */
export function compressScreenshotToJpeg(base64: string): string {
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength === 0) return base64;
    const rgba = decodeToRgba(bytes);
    const scaled = scaleToMaxWidth(rgba, VISION_SCREENSHOT_MAX_WIDTH);
    const jpeg = encodeJpeg(
      {
        data: Buffer.from(scaled.data),
        height: scaled.height,
        width: scaled.width,
      },
      VISION_JPEG_QUALITY
    );
    return Buffer.from(jpeg.data).toString("base64");
  } catch {
    return base64;
  }
}

function decodeToRgba(bytes: Buffer): RgbaImage {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const png = decodePng(bytes);
    return {
      data: toRgba(png.data, png.width, png.height, png.channels),
      height: png.height,
      width: png.width,
    };
  }
  const jpeg = decodeJpeg(bytes, { useTArray: true });
  return {
    data: jpeg.data,
    height: jpeg.height,
    width: jpeg.width,
  };
}

function toRgba(
  data: ArrayLike<number>,
  width: number,
  height: number,
  channels: number
) {
  if (channels === 4) {
    return data instanceof Uint8Array ? data : Uint8Array.from(data);
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const dest = index * 4;
    rgba[dest] = data[source] ?? 0;
    rgba[dest + 1] = data[source + Math.min(1, channels - 1)] ?? 0;
    rgba[dest + 2] = data[source + Math.min(2, channels - 1)] ?? 0;
    rgba[dest + 3] = channels === 2 ? (data[source + 1] ?? 255) : 255;
  }
  return rgba;
}

function scaleToMaxWidth(image: RgbaImage, maxWidth: number): RgbaImage {
  if (image.width <= maxWidth) return image;
  const width = maxWidth;
  const height = Math.max(
    1,
    Math.round((image.height * maxWidth) / image.width)
  );
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(
      image.height - 1,
      Math.floor((y * image.height) / height)
    );
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(
        image.width - 1,
        Math.floor((x * image.width) / width)
      );
      const source = (sourceY * image.width + sourceX) * 4;
      const dest = (y * width + x) * 4;
      data[dest] = image.data[source] ?? 0;
      data[dest + 1] = image.data[source + 1] ?? 0;
      data[dest + 2] = image.data[source + 2] ?? 0;
      data[dest + 3] = image.data[source + 3] ?? 255;
    }
  }
  return { data, height, width };
}
