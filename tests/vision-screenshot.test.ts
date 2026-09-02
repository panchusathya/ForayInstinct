import { describe, expect, it } from "vitest";
import { decode } from "jpeg-js";
import { encode } from "fast-png";
import {
  VISION_SCREENSHOT_MAX_WIDTH,
  compressScreenshotToJpeg,
} from "@/lib/vision-screenshot";

describe("vision screenshot compression", () => {
  it("turns a raw 1280×720 PNG into a much smaller JPEG", () => {
    const width = 1280;
    const height = 720;
    const data = new Uint8Array(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 40;
      data[index + 1] = 80;
      data[index + 2] = 160;
      data[index + 3] = 255;
    }
    const png = encode({ data, height, width });
    const jpeg = Buffer.from(
      compressScreenshotToJpeg(Buffer.from(png).toString("base64")),
      "base64"
    );
    const decoded = decode(jpeg, { useTArray: true });
    expect(jpeg.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
    expect(decoded.width).toBe(VISION_SCREENSHOT_MAX_WIDTH);
    expect(decoded.height).toBe(432);
    expect(jpeg.byteLength).toBeLessThan((width * height * 4) / 20);
  });
});
