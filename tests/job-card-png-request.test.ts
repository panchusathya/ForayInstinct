import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "job-card-secret",
    BETTER_AUTH_URL: "http://localhost:3000",
  },
}));

import { renderJobCardPng } from "@/lib/goforay/request-job-card-png";

describe("job card png request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the card to the Next.js renderer and returns the bytes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(Buffer.from("png-bytes"), { status: 200 })
      );
    vi.stubGlobal("fetch", fetch);

    const result = await renderJobCardPng(
      {
        company: "Example AI",
        location: "Remote",
        reasons: ["strong ml"],
        title: "Engineer",
        url: "https://jobs.example.co/ml-engineer",
      },
      2,
      3
    );

    expect(result).toEqual({
      bytes: Buffer.from("png-bytes"),
      filename: "example-ai-role.png",
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      new URL("/api/job-card-png", "http://localhost:3000"),
      expect.objectContaining({
        headers: {
          "content-type": "application/json",
          "x-job-card-secret": "job-card-secret",
        },
        method: "POST",
      })
    );
  });

  it("returns nothing when the renderer fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(null, { status: 500 }))
    );
    await expect(
      renderJobCardPng(
        {
          company: "Example AI",
          location: "Remote",
          reasons: ["strong ml"],
          title: "Engineer",
          url: "https://jobs.example.co/ml-engineer",
        },
        1,
        1
      )
    ).resolves.toBeUndefined();
  });
});
