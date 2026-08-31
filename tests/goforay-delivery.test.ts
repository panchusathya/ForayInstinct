import { describe, expect, it } from "vitest";
import { formatCandidateDelivery } from "@/lib/goforay/delivery";
import { renderGoForayJobCard } from "@/lib/goforay/job-cards";

describe("candidate delivery formatter", () => {
  it("unwraps a model JSON envelope and protects URLs while lowercasing prose", () => {
    expect(
      formatCandidateDelivery(
        '```json\n{"message":"Great — see https://Example.com/Role"}\n```'
      )
    ).toEqual({ bubbles: ["great - see https://Example.com/Role"] });
  });

  it("splits long copy into no more than five candidate bubbles", () => {
    const value = Array.from(
      { length: 8 },
      (_, index) => `Point ${index + 1}.`
    ).join("\n\n");
    const delivery = formatCandidateDelivery(value);
    expect(delivery.bubbles).toHaveLength(5);
    expect(delivery.bubbles[0]).toBe("point 1.");
  });

  it("removes an allowed hidden reaction directive", () => {
    expect(
      formatCandidateDelivery("thanks, that means a lot [[react:heart]]")
    ).toEqual({
      bubbles: ["thanks, that means a lot"],
      reaction: "heart",
    });
  });

  it("strips a kernel live-view link the candidate has no use for", () => {
    expect(
      formatCandidateDelivery(
        [
          "I filled the application for Staff Engineer.",
          "You can watch it here: https://abc123.live.onkernel.com/view",
          "https://boards.example.com/apply",
        ].join("\n")
      )
    ).toEqual({
      bubbles: [
        "i filled the application for staff engineer.\nhttps://boards.example.com/apply",
      ],
    });
  });

  it("keeps the live view for a challenge only the candidate can complete", () => {
    // A CAPTCHA Foray could not solve is the one case the link is the answer.
    expect(
      formatCandidateDelivery(
        "There's a captcha I can't solve. Tap in and clear it:[[takeover]]https://abc123.live.onkernel.com/view"
      )
    ).toEqual({
      bubbles: [
        "there's a captcha i can't solve. tap in and clear it:\nhttps://abc123.live.onkernel.com/view",
      ],
    });
  });

  it("uses a compact text card that keeps the apply URL", () => {
    expect(
      renderGoForayJobCard(
        {
          company: "Example AI",
          location: "Remote",
          posting_id: "posting-1",
          reasons: ["Strong ML background"],
          title: "Machine Learning Engineer",
          url: "https://jobs.example.co/ml-engineer",
        },
        2,
        5
      )
    ).toBe(
      // The matching rationale is internal ranking signal, not card copy.
      '2/5  machine learning engineer · example ai\nremote\nhttps://jobs.example.co/ml-engineer\nreply "apply 2" to apply'
    );
  });
});
