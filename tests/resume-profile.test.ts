import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn<(_input: unknown) => Promise<{ text: string }>>(),
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  gateway: () => ({}),
  wrapLanguageModel: () => ({}),
}));

vi.mock("@/lib/model-config", () => ({ browserLanguageModel: "test-model" }));

import { extractProfileFromResume } from "@/lib/resume-profile";

const resume = { bytes: Buffer.from("%PDF-1.4"), mimeType: "application/pdf" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reading a profile off a resume", () => {
  it("keeps the facts a resume actually establishes", async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        headline: "Strategic Finance",
        contactEmail: "sathya@example.com",
        legalFirstName: "Sathya",
        legalLastName: "Panchu",
        linkedInUrl: "https://linkedin.com/in/sathya",
        locationCity: "San Francisco",
        locationCountryCode: "US",
        locationRegion: "CA",
        workHistory: [
          {
            company: "WestBridge",
            current: true,
            startYear: 2021,
            title: "Investor",
          },
        ],
      }),
    });

    const patch = await extractProfileFromResume(resume);

    expect(patch).toMatchObject({
      contactEmail: "sathya@example.com",
      legalFirstName: "Sathya",
      legalLastName: "Panchu",
      locationCity: "San Francisco",
    });
    expect(patch?.links).toEqual([
      { label: "LinkedIn", url: "https://linkedin.com/in/sathya" },
    ]);
    expect(patch?.workHistory?.[0]).toMatchObject({
      company: "WestBridge",
      current: true,
      title: "Investor",
    });
  });

  it("never carries work authorization off a resume", async () => {
    // A resume does not establish legal status, and a wrong answer here goes
    // to an employer under the candidate's name.
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        legalFirstName: "Sathya",
        requiresSponsorshipNow: "no",
        workAuthorization: "us_citizen",
      }),
    });

    const patch = await extractProfileFromResume(resume);

    expect(patch).toEqual({ legalFirstName: "Sathya" });
  });

  it("sends the document itself rather than a text dump", async () => {
    mocks.generateText.mockResolvedValue({ text: "{}" });

    await extractProfileFromResume(resume);

    const sent = JSON.stringify(mocks.generateText.mock.calls[0]?.[0] ?? {});
    expect(sent).toContain('"type":"file"');
    expect(sent).toContain('"mediaType":"application/pdf"');
  });

  it("keeps nothing when the model returns prose", async () => {
    mocks.generateText.mockResolvedValue({ text: "I could not read it." });

    await expect(extractProfileFromResume(resume)).resolves.toBeUndefined();
  });

  it("drops an entry missing a company or title", async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        workHistory: [
          { company: "", title: "Analyst" },
          { company: "WestBridge", title: "Investor" },
        ],
      }),
    });

    const patch = await extractProfileFromResume(resume);

    expect(patch?.workHistory).toHaveLength(1);
  });
});
