import { describe, expect, it } from "vitest";
import type { GoForayJobCard } from "@/lib/goforay/job-cards";
import { resolvePresentedRole } from "@/lib/goforay/presented-roles";

const cards: GoForayJobCard[] = [
  {
    company: "The Toro Company",
    location: "Remote, USA",
    reasons: ["M&A modeling"],
    title: "Sr. Analyst, Corporate Development",
    url: "https://jobs.thetorocompany.com/job/bloomington/corp-dev/1",
  },
  {
    company: "Example AI",
    location: "Remote",
    posting_id: "11111111-1111-4111-8111-111111111111",
    reasons: ["Strong ML background"],
    title: "Machine Learning Engineer",
    url: "https://jobs.example.co/ml-engineer",
  },
];

describe("presented role resolution", () => {
  it("resolves apply 1 / company query / posting id to the stored apply URL", () => {
    expect(resolvePresentedRole({ selection: 1 }, cards)?.url).toBe(
      "https://jobs.thetorocompany.com/job/bloomington/corp-dev/1"
    );
    expect(
      resolvePresentedRole({ query: "toro corporate" }, cards)?.title
    ).toBe("Sr. Analyst, Corporate Development");
    expect(
      resolvePresentedRole(
        { job_posting_id: "11111111-1111-4111-8111-111111111111" },
        cards
      )?.url
    ).toBe("https://jobs.example.co/ml-engineer");
  });

  it("keeps a pasted apply URL even when it was not in the last batch", () => {
    expect(
      resolvePresentedRole(
        { apply_url: "https://jobs.example.co/new-role" },
        cards
      )
    ).toEqual(
      expect.objectContaining({
        title: "Open role",
        url: "https://jobs.example.co/new-role",
      })
    );
  });

  it("returns nothing when the candidate has no stored lead and no URL", () => {
    expect(
      resolvePresentedRole({ query: "missing company" }, cards)
    ).toBeUndefined();
    expect(resolvePresentedRole({ selection: 9 }, cards)).toBeUndefined();
  });
});
