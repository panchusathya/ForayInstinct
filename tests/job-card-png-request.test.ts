import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "job-card-secret",
    BETTER_AUTH_URL: "http://localhost:3000",
  },
}));

import { jobCardSecret } from "@/lib/goforay/job-card-secret";
import { renderJobCardPng } from "@/lib/goforay/request-job-card-png";

const card = {
  company: "Example AI",
  location: "Remote",
  reasons: ["strong ml"],
  title: "Engineer",
  url: "https://jobs.example.co/ml-engineer",
};

describe("job card png request", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts the card to the Next.js renderer and returns the bytes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(Buffer.from("png-bytes"), { status: 200 })
      );
    vi.stubGlobal("fetch", fetch);

    const result = await renderJobCardPng(card, 2, 3);

    expect(result).toEqual({
      bytes: Buffer.from("png-bytes"),
      filename: "example-ai-role.png",
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      new URL("/api/job-card-png", "http://localhost:3000"),
      expect.objectContaining({
        headers: {
          "content-type": "application/json",
          // Derived from the signing secret, never the signing secret itself.
          "x-job-card-secret": jobCardSecret(),
        },
        method: "POST",
      })
    );
  });

  // Every failure below degrades to the text card, so the log line is the only
  // trace that a candidate got text instead of an image.
  it("reports the status when the renderer rejects the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(null, { status: 500 }))
    );

    await expect(renderJobCardPng(card, 1, 1)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      "[goforay] job-card PNG route rejected the request",
      expect.objectContaining({ status: 500 })
    );
  });

  it("reports an empty body rather than sending a zero-byte image", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(Buffer.alloc(0), { status: 200 }))
    );

    await expect(renderJobCardPng(card, 1, 1)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      "[goforay] job-card PNG route returned an empty body",
      expect.objectContaining({ company: "Example AI" })
    );
  });

  it("reports an unreachable route", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error("ECONNREFUSED"))
    );

    await expect(renderJobCardPng(card, 1, 1)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      "[goforay] job-card PNG route unreachable",
      expect.objectContaining({ message: "ECONNREFUSED" })
    );
  });
});

describe("the card route's secret", () => {
  it("is not the session-signing secret, and is checked in constant time", async () => {
    const { isJobCardSecret } = await import("@/lib/goforay/job-card-secret");
    const secret = jobCardSecret();
    expect(secret).not.toBe("job-card-secret");
    expect(secret).toMatch(/^[0-9a-f]{64}$/u);
    expect(isJobCardSecret(secret)).toBe(true);
    expect(isJobCardSecret("job-card-secret")).toBe(false);
    // Same length, one byte off.
    expect(
      isJobCardSecret(
        `${secret.slice(0, -1)}${secret.endsWith("0") ? "1" : "0"}`
      )
    ).toBe(false);
    expect(isJobCardSecret(null)).toBe(false);
  });
});
