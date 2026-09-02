import { describe, expect, it } from "vitest";
import {
  COORDINATOR_MAX_OUTPUT_TOKENS,
  WORKER_MAX_OUTPUT_TOKENS,
  capMaxOutputTokens,
  forceMaxOutputTokensMiddleware,
  keepLastPromptImage,
  keepLastPromptImageMiddleware,
} from "@/lib/model-request";

describe("per-call generation caps", () => {
  it("forces a small output cap even when the provider default is 65536", async () => {
    expect(COORDINATOR_MAX_OUTPUT_TOKENS).toBe(1_000);
    expect(WORKER_MAX_OUTPUT_TOKENS).toBe(2_000);
    expect(capMaxOutputTokens({}, 1_000).maxOutputTokens).toBe(1_000);
    expect(
      capMaxOutputTokens({ maxOutputTokens: 65_536 }, 2_000).maxOutputTokens
    ).toBe(2_000);
    expect(
      capMaxOutputTokens({ maxOutputTokens: 500 }, 1_000).maxOutputTokens
    ).toBe(500);

    const coordinator = forceMaxOutputTokensMiddleware(1_000);
    const worker = forceMaxOutputTokensMiddleware(2_000);
    const omitted = await coordinator.transformParams?.({
      params: {},
      type: "generate",
    });
    const oversized = await worker.transformParams?.({
      params: { maxOutputTokens: 65_536 },
      type: "generate",
    });
    expect(omitted?.maxOutputTokens).toBe(1_000);
    expect(oversized?.maxOutputTokens).toBe(2_000);
  });

  it("drops older screenshot file parts from the worker prompt", async () => {
    const prompt = [
      {
        content: [
          { mediaType: "image/jpeg", type: "file", data: "one" },
          { text: "first look", type: "text" },
        ],
        role: "user",
      },
      {
        content: [
          { mediaType: "image/jpeg", type: "file", data: "two" },
          { mediaType: "image/jpeg", type: "file", data: "three" },
        ],
        role: "tool",
      },
    ];
    const trimmed = keepLastPromptImage(prompt);
    const files = JSON.stringify(trimmed).match(/"(one|two|three)"/g) ?? [];
    expect(files).toEqual(['"three"']);
    expect(JSON.stringify(prompt)).toContain("one");

    const middleware = keepLastPromptImageMiddleware();
    const throughMiddleware = await middleware.transformParams?.({
      params: { prompt },
      type: "generate",
    });
    const middlewareFiles =
      JSON.stringify(throughMiddleware?.prompt).match(/"(one|two|three)"/g) ??
      [];
    expect(middlewareFiles).toEqual(['"three"']);
  });
});
