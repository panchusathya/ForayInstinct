import { describe, expect, it } from "vitest";
import {
  isClosedPosting,
  locationFromResult,
  reasonsForCandidate,
  relevanceTokens,
  scoreRoleCandidate,
} from "@/lib/goforay/relevance";

const wanted = relevanceTokens("strategic finance", "senior");

function score(title: string, url: string, text = "") {
  return scoreRoleCandidate({ title, url, text, wanted });
}

describe("goforay role relevance", () => {
  describe("rejections", () => {
    // The reported incident: a private equity firm arrived as a strategic
    // finance role because every public hit became a card.
    it("rejects a firm's homepage", () => {
      expect(score("Turn River", "https://turnriver.com/")).toMatchObject({
        verdict: "reject",
        reason: "not-a-posting",
      });
    });

    it("rejects a firm's careers landing page", () => {
      expect(score("Careers", "https://turnriver.com/careers")).toMatchObject({
        verdict: "reject",
      });
    });

    it("rejects a portfolio page even with a deep path", () => {
      expect(
        score(
          "Portfolio Companies",
          "https://turnriver.com/portfolio/acme-software"
        )
      ).toMatchObject({ verdict: "reject", reason: "landing-page" });
    });

    it("rejects an aggregator that restates a posting behind a sign-in", () => {
      expect(
        score(
          "Senior Analyst, Strategic Finance",
          "https://www.linkedin.com/jobs/view/12345"
        )
      ).toMatchObject({ verdict: "reject", reason: "aggregator-host" });
    });

    it("rejects a real posting for the wrong role", () => {
      expect(
        score(
          "Staff Backend Engineer",
          "https://jobs.lever.co/example/2f1c9a44-1b2e-4c3d-9e8f-7a6b5c4d3e2f"
        )
      ).toMatchObject({ verdict: "reject", reason: "title-mismatch" });
    });

    it("rejects a posting the page says is closed", () => {
      // A closed ATS posting keeps the same URL and the same title as an open
      // one, so shape and title can never catch it. The body is all that is
      // left, and the search response already carries it.
      expect(
        score(
          "Senior Analyst, Strategic Finance",
          "https://boards.greenhouse.io/example/jobs/4123456",
          "This role is no longer accepting applications."
        )
      ).toMatchObject({ verdict: "reject", reason: "closed-posting" });
    });

    it("rejects a generic title on an otherwise valid posting path", () => {
      expect(
        score(
          "Open Positions",
          "https://boards.greenhouse.io/example/jobs/4123456"
        )
      ).toMatchObject({ verdict: "reject", reason: "generic-title" });
    });
  });

  describe("acceptances", () => {
    it("accepts an ATS posting for the role asked for", () => {
      const result = score(
        "Senior Analyst, Strategic Finance",
        "https://boards.greenhouse.io/example/jobs/4123456"
      );
      expect(result.verdict).toBe("accept");
      expect(result.matched).toContain("strategic finance");
    });

    it("accepts the title a hiring team actually writes", () => {
      // "Manager, FP&A" is the same job as "strategic finance".
      expect(
        score(
          "Manager, FP&A",
          "https://jobs.lever.co/example/2f1c9a44-1b2e-4c3d-9e8f-7a6b5c4d3e2f"
        )
      ).toMatchObject({ verdict: "accept" });
    });

    it("accepts corporate development as strategic finance", () => {
      expect(
        score(
          "Sr. Analyst, Corporate Development",
          "https://jobs.thetorocompany.com/careers/corp-dev-analyst-1234"
        )
      ).toMatchObject({ verdict: "accept" });
    });

    it("accepts a role slug on a job-board subdomain", () => {
      // A `jobs.` host already says the path is a posting, so a one-segment
      // role slug there is a real opening rather than a marketing page.
      expect(
        score(
          "Strategic Finance Analyst",
          "https://jobs.example.co/strategic-finance"
        )
      ).toMatchObject({ verdict: "accept" });
    });

    it("still rejects a bare role slug on a plain company domain", () => {
      expect(
        score("Strategic Growth", "https://turnriver.com/strategic-growth")
      ).toMatchObject({ verdict: "reject", reason: "not-a-posting" });
    });

    it("accepts a posting on a company domain with a discriminating path", () => {
      expect(
        score(
          "Senior Manager, Strategic Finance",
          "https://example.com/careers/senior-manager-strategic-finance-4821"
        )
      ).toMatchObject({ verdict: "accept" });
    });

    it("reads the body when an ATS titles the page with just the company", () => {
      expect(
        score(
          "Example AI",
          "https://boards.greenhouse.io/example/jobs/4123456",
          "Strategic finance analyst owning the three statement model."
        )
      ).toMatchObject({ verdict: "accept" });
    });

    it("accepts any posting when nothing specific was asked for", () => {
      expect(
        scoreRoleCandidate({
          title: "Staff Backend Engineer",
          url: "https://boards.greenhouse.io/example/jobs/4123456",
          text: "",
          wanted: [],
        })
      ).toMatchObject({ verdict: "accept", matched: [] });
    });
  });

  describe("isClosedPosting", () => {
    it.each([
      "This role is no longer accepting applications.",
      "We are not currently accepting applications for this opening.",
      "This position has been filled.",
      "This job is closed.",
      "Applications are now closed.",
    ])("reads a takedown notice: %s", (text) => {
      expect(isClosedPosting(text)).toBe(true);
    });

    it.each([
      "You will own the annual plan and the three statement model.",
      "Applications are reviewed on a rolling basis.",
      "We are no longer a ten person startup, and this role reflects that.",
    ])("leaves an open posting alone: %s", (text) => {
      expect(isClosedPosting(text)).toBe(false);
    });
  });

  describe("relevanceTokens", () => {
    it("expands a role into the titles hiring teams write", () => {
      expect(wanted).toContain("strategic finance");
      expect(wanted).toContain("fp&a");
      expect(wanted).toContain("corporate development");
    });

    it("never turns seniority into a requirement of its own", () => {
      expect(relevanceTokens("strategic finance", "senior")).not.toContain(
        "senior"
      );
    });
  });

  describe("locationFromResult", () => {
    it("reads the posting's own location", () => {
      expect(
        locationFromResult("Analyst", "Based in San Francisco, CA (Hybrid).")
      ).toBe("San Francisco, CA (Hybrid)");
    });

    it("reads a work mode when there is no city", () => {
      expect(locationFromResult("Analyst - Remote", "")).toBe("Remote");
    });

    // The old code echoed the requested location back onto the card, so a
    // posting anywhere read as whatever the candidate had searched for.
    it("returns empty rather than inventing a location", () => {
      expect(
        locationFromResult("Senior Analyst, Strategic Finance", "Apply today.")
      ).toBe("");
    });
  });

  describe("reasonsForCandidate", () => {
    it("leads with the match, not a slice of the page", () => {
      const reasons = reasonsForCandidate({
        matched: ["strategic finance"],
        text: "We use cookies to improve your experience. Sign in to continue.",
        wanted,
      });
      expect(reasons[0]).toBe("matches strategic finance");
      expect(reasons).toHaveLength(1);
    });

    it("adds a sentence about the role when the page has one", () => {
      const reasons = reasonsForCandidate({
        matched: ["strategic finance"],
        text:
          "Acme Corp | Careers | Login. " +
          "You will own the annual plan and the three statement model. ",
        wanted,
      });
      expect(reasons[1]).toBe(
        "You will own the annual plan and the three statement model."
      );
    });

    it("emits nothing when there is no honest reason to give", () => {
      expect(reasonsForCandidate({ matched: [], text: "", wanted })).toEqual(
        []
      );
    });
  });
});
