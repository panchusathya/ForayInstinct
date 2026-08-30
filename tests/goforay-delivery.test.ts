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

  it("uses a compact no-link text fallback for a job card", () => {
    expect(
      renderGoForayJobCard(
        {
          company: "Example AI",
          location: "Remote",
          posting_id: "posting-1",
          reasons: ["Strong ML background"],
          title: "Machine Learning Engineer",
        },
        2,
        5
      )
    ).toBe(
      '2/5  machine learning engineer · example ai\nremote\n· strong ml background\nreply "apply 2" to apply'
    );
  });
});
