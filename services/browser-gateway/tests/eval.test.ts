import { describe, expect, it } from "vitest";
import { runPlaywrightCode } from "../src/eval.ts";

const scope = { browser: {}, context: {}, page: { marker: "the-page" } };

describe("runPlaywrightCode", () => {
  it("resolves with a serialized result", async () => {
    const response = await runPlaywrightCode(scope, "return 1 + 1;", 5);
    expect(response).toEqual({ result: 2, success: true });
  });

  it("exposes browser, page, and context in scope", async () => {
    const response = await runPlaywrightCode(scope, "return page.marker;", 5);
    expect(response).toEqual({ result: "the-page", success: true });
  });

  it("supports top-level await and statement blocks", async () => {
    const response = await runPlaywrightCode(
      scope,
      "const value = await Promise.resolve(7); return { value };",
      5
    );
    expect(response).toEqual({ result: { value: 7 }, success: true });
  });

  it("drops non-JSON-serializable parts of the result", async () => {
    const response = await runPlaywrightCode(
      scope,
      "return { a: 1, fn: () => 1 };",
      5
    );
    expect(response).toEqual({ result: { a: 1 }, success: true });
  });

  it("returns success with no result for undefined", async () => {
    const response = await runPlaywrightCode(scope, "return undefined;", 5);
    expect(response).toEqual({ success: true });
  });

  it("carries a thrown error and its stack in the envelope", async () => {
    const response = await runPlaywrightCode(
      scope,
      "throw new Error('boom');",
      5
    );
    expect(response.success).toBe(false);
    expect(response.error).toContain("boom");
  });

  it("reports compile errors as failures", async () => {
    const response = await runPlaywrightCode(scope, "this is not js", 5);
    expect(response.success).toBe(false);
    expect(response.error).toBeTruthy();
  });

  it("times out code that never resolves", async () => {
    const response = await runPlaywrightCode(
      scope,
      "await new Promise(() => {});",
      0.05
    );
    expect(response.success).toBe(false);
    expect(response.error).toMatch(/timed out/iu);
  });
});
