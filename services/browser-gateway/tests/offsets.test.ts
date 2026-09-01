import { describe, expect, it } from "vitest";
import { computeSliceOffsets } from "../src/screenshot.ts";

describe("computeSliceOffsets", () => {
  it("returns a single zero offset when nothing scrolls", () => {
    expect(computeSliceOffsets({ clientHeight: 800, maxScroll: 0 }, 3)).toEqual(
      [0]
    );
  });

  it("covers a short page with top and bottom", () => {
    expect(
      computeSliceOffsets({ clientHeight: 800, maxScroll: 700 }, 10)
    ).toEqual([0, 700]);
  });

  it("spreads offsets evenly under the cap and ends at the bottom", () => {
    const offsets = computeSliceOffsets(
      { clientHeight: 800, maxScroll: 5_000 },
      3
    );
    expect(offsets).toEqual([0, 2_500, 5_000]);
  });

  it("uses roughly one viewport (with overlap) per step under the cap", () => {
    const offsets = computeSliceOffsets(
      { clientHeight: 1_000, maxScroll: 1_800 },
      10
    );
    // step = 900 -> needed = 3 slices: 0, 900, 1800.
    expect(offsets).toEqual([0, 900, 1_800]);
  });

  it("is strictly increasing with no duplicates", () => {
    const offsets = computeSliceOffsets(
      { clientHeight: 10_000, maxScroll: 3 },
      10
    );
    for (let index = 1; index < offsets.length; index += 1) {
      expect(offsets[index]).toBeGreaterThan(offsets[index - 1] ?? Number.NaN);
    }
    expect(offsets.at(-1)).toBe(3);
  });

  it("never exceeds the slice cap", () => {
    const offsets = computeSliceOffsets(
      { clientHeight: 500, maxScroll: 100_000 },
      4
    );
    expect(offsets).toHaveLength(4);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(100_000);
  });
});
