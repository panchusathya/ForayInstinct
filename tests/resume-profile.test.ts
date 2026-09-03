import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn<(_input: unknown) => Promise<{ text: string }>>(),
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  gateway: () => ({}),
  wrapLanguageModel: () => ({}),
}));

vi.mock("@/lib/model-config", () => ({
  browserLanguageModel: "vision-model",
  chatLanguageModel: "text-model",
}));

import {
  extractProfileFromResume,
  resumeContactFacts,
  resumeText,
} from "@/lib/resume-profile";

const plainResume = {
  extractedText:
    "Sathya Panchu Strategic Finance San Francisco, CA WestBridge Investor 2021 to present",
  mimeType: "application/pdf",
};

const resumeWithContact = {
  extractedText:
    "Sathya Panchu sathya@example.com linkedin.com/in/sathya-panchu San Francisco, CA",
  mimeType: "application/pdf",
};

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

    const patch = await extractProfileFromResume(plainResume);

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

    const patch = await extractProfileFromResume(plainResume);

    expect(patch).toEqual({ legalFirstName: "Sathya" });
  });

  it("sends the extracted text to the text model, never the file", async () => {
    // The file itself, sent to the vision model through the gateway, was
    // rejected on every call, so extraction silently never ran in production.
    mocks.generateText.mockResolvedValue({ text: "{}" });

    await extractProfileFromResume(plainResume);

    const call = mocks.generateText.mock.calls[0]?.[0];
    const sent = JSON.stringify(call ?? {});
    expect(sent).not.toContain('"type":"file"');
    expect(sent).toContain("WestBridge Investor");
    expect(call).toMatchObject({ model: "text-model" });
  });

  it("finds the contact facts exactly and lets them win over the model", async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        contactEmail: "guessed@example.com",
        legalFirstName: "Sathya",
        linkedInUrl: "https://linkedin.com/in/someone-else",
      }),
    });

    const patch = await extractProfileFromResume(resumeWithContact);

    expect(patch).toMatchObject({
      contactEmail: "sathya@example.com",
      legalFirstName: "Sathya",
    });
    expect(patch?.links).toEqual([
      { label: "LinkedIn", url: "https://linkedin.com/in/sathya-panchu" },
    ]);
  });

  it("reads contact facts with no model at all", () => {
    expect(resumeContactFacts(resumeWithContact.extractedText)).toEqual({
      contactEmail: "sathya@example.com",
      linkedInUrl: "https://linkedin.com/in/sathya-panchu",
    });
    expect(resumeContactFacts(plainResume.extractedText)).toEqual({});
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("keeps nothing when the model returns prose", async () => {
    mocks.generateText.mockResolvedValue({ text: "I could not read it." });

    await expect(
      extractProfileFromResume(plainResume)
    ).resolves.toBeUndefined();
  });

  it("reads nothing off a document with no readable text", async () => {
    // Glyph codes from an encoded PDF are not facts, and a model asked about
    // them would only invent some.
    const unreadable = {
      extractedText: " 12 0 R",
      mimeType: "application/pdf",
    };

    expect(resumeText(unreadable)).toBe("");
    await expect(extractProfileFromResume(unreadable)).resolves.toBeUndefined();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("falls back to the bytes when no text was stored", () => {
    const text = resumeText({
      bytes: Buffer.from("Sathya Panchu, sathya@example.com"),
      filename: "resume.txt",
      mimeType: "text/plain",
    });

    expect(text).toContain("Sathya Panchu");
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

    const patch = await extractProfileFromResume(plainResume);

    expect(patch?.workHistory).toHaveLength(1);
  });
});
