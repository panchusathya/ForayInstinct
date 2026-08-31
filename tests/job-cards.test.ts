import { describe, expect, it } from "vitest";
import { userVisibleParts } from "@/app/_lib/user-visible-parts";
import {
  contrastRatio,
  INK_LIGHT,
  LIGHT_GROUND,
  NEUTRAL_ACCENT,
  NEUTRAL_GROUND,
  paletteFor,
} from "@/lib/goforay/card-palette";
import {
  employerDomainFromUrl,
  isAtsOrAggregator,
  sanitizeHostname,
} from "@/lib/goforay/card-logo";
import {
  cleanTitle,
  isVisibleJobCardToolPart,
  jobCardView,
  renderGoForayJobCard,
  jobCardsFromToolOutput,
} from "@/lib/goforay/job-cards";

describe("job card projection", () => {
  it("strips a trailing at-company clause from scraped titles", () => {
    expect(cleanTitle("Engineer at Wipro", "Wipro")).toBe("Engineer");
    expect(cleanTitle("Engineer at Wipro at our Houston office", "Wipro")).toBe(
      "Engineer at Wipro at our Houston office"
    );
  });

  it("clips reasons and ordinalizes the footer", () => {
    const view = jobCardView(
      {
        company: "Example AI",
        location: "Remote",
        reasons: ["strong ml background", "distributed systems", "extra"],
        source_label: "open market",
        title: "Machine Learning Engineer",
        url: "https://jobs.example.co/ml-engineer",
      },
      2,
      3
    );
    expect(view.reasons).toHaveLength(2);
    expect(view.footerPosition).toBe("2 of 3");
    expect(view.sourceLabel).toBe("O P E N   M A R K E T");
    expect(view.applyReply).toBe("apply 2");
  });

  it("renders no location line rather than a location it does not know", () => {
    // A public hit whose location cannot be read now carries "", where it used
    // to carry the search term the candidate typed.
    const card = {
      company: "Example AI",
      location: "",
      reasons: ["matches strategic finance"],
      title: "Senior Analyst, Strategic Finance",
      url: "https://boards.greenhouse.io/example/jobs/4123456",
    };
    expect(jobCardView(card, 1, 1).meta).toBe("");
    expect(renderGoForayJobCard(card, 1, 1)).toContain(
      "https://boards.greenhouse.io/example/jobs/4123456"
    );
  });

  it("reads cards from a role-search tool payload", () => {
    const cards = jobCardsFromToolOutput({
      cards: [
        {
          company: "Example AI",
          location: "Remote",
          reasons: ["strong ml"],
          title: "Engineer",
          url: "https://jobs.example.co/ml-engineer",
        },
      ],
    });
    expect(cards).toHaveLength(1);
    expect(
      isVisibleJobCardToolPart({
        output: { cards },
        toolName: "find_goforay_roles",
        type: "dynamic-tool",
      })
    ).toBe(true);
    expect(
      isVisibleJobCardToolPart({
        output: { cards },
        toolName: "web_search",
        type: "dynamic-tool",
      })
    ).toBe(false);
  });
});

describe("job card palette", () => {
  it("uses a dark brand as the ground with readable light ink", () => {
    const palette = paletteFor({ primary: "#0b1f4a" });
    expect(palette.branded).toBe(true);
    expect(palette.ground).toBe("#0b1f4a");
    expect(palette.ink).toBe(INK_LIGHT);
    expect(contrastRatio(palette.ground, palette.ink)).toBeGreaterThanOrEqual(
      4.5
    );
  });

  it("keeps a pale brand as the accent on a light ground", () => {
    const palette = paletteFor({ primary: "#f7e94f" });
    expect(palette.branded).toBe(true);
    expect(palette.ground).toBe(LIGHT_GROUND);
    expect(contrastRatio(palette.ground, palette.ink)).toBeGreaterThanOrEqual(
      4.5
    );
  });

  it("falls back to Foray green when there is no usable brand", () => {
    const palette = paletteFor();
    expect(palette.branded).toBe(false);
    expect(palette.ground).toBe(NEUTRAL_GROUND);
    expect(palette.accent).toBe(NEUTRAL_ACCENT);
    expect(contrastRatio(palette.ground, palette.ink)).toBeGreaterThanOrEqual(
      4.5
    );
  });
});

describe("employer logo domain", () => {
  it("skips ATS and aggregator hosts", () => {
    expect(sanitizeHostname("https://boards.greenhouse.io/acme")).toBe(
      "boards.greenhouse.io"
    );
    expect(isAtsOrAggregator("boards.greenhouse.io")).toBe(true);
    expect(
      employerDomainFromUrl("https://boards.greenhouse.io/acme/jobs/1")
    ).toBe("");
    expect(employerDomainFromUrl("https://jobs.example.co/ml-engineer")).toBe(
      "jobs.example.co"
    );
    expect(sanitizeHostname("http://127.0.0.1/logo")).toBe("");
  });
});

describe("user-visible chat parts", () => {
  it("keeps role-search tool parts that have cards", () => {
    const visible = userVisibleParts({
      id: "msg-1",
      parts: [
        {
          input: {},
          output: {
            cards: [
              {
                company: "Example AI",
                location: "Remote",
                reasons: ["strong ml"],
                title: "Engineer",
                url: "https://jobs.example.co/ml-engineer",
              },
            ],
          },
          state: "output-available",
          toolCallId: "call-1",
          toolName: "find_goforay_roles",
          type: "dynamic-tool",
        },
        {
          input: {},
          output: { results: [] },
          state: "output-available",
          toolCallId: "call-2",
          toolName: "web_search",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      toolName: "find_goforay_roles",
      type: "dynamic-tool",
    });
  });
});
