import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  click:
    vi.fn<
      (
        _sessionId: string,
        _control: Record<string, unknown>
      ) => Promise<Record<string, unknown>>
    >(),
  executePlaywright:
    vi.fn<
      (
        _sessionId: string,
        _request: { code: string }
      ) => Promise<{ result?: unknown; success: boolean }>
    >(),
  helper: vi.fn<
    (_input: {
      fields: { selector: string }[];
      profileSummary: string;
    }) => Promise<{
      blockers: string[];
      fills: { selector: string; value: string }[];
    }>
  >(),
  log: vi.fn<(_entry: Record<string, unknown>) => void>(),
}));

vi.mock("@/lib/application-execution", () => ({
  applicationExecutionLog: mocks.log,
}));
vi.mock("@/lib/application-runner/ambiguous", () => ({
  suggestUnmappedFills: mocks.helper,
}));
vi.mock("@/lib/application-runner/navigate", () => ({
  clickControl: mocks.click,
}));
vi.mock("@/lib/browser", () => ({
  browserProvider: { executePlaywright: mocks.executePlaywright },
}));

import {
  fillRepeaters,
  mapEntryToBlock,
} from "@/lib/application-runner/repeaters";
import { emptyCandidateProfile } from "@/lib/candidate-profile";

const field = (
  selector: string,
  label: string,
  extra: Partial<{ options: string[]; tag: string; type: string }> = {}
) => ({
  label,
  name: selector.replace("#", ""),
  required: false,
  selector,
  tag: extra.tag ?? "input",
  type: extra.type ?? "text",
  ...(extra.options ? { options: extra.options } : {}),
});

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const workBlock = (n: number) => [
  field(`#title-${String(n)}`, "Job Title*"),
  field(`#company-${String(n)}`, "Company*"),
  field(`#location-${String(n)}`, "Location"),
  field(`#current-${String(n)}`, "I currently work here", {
    tag: "checkbox",
    type: "checkbox",
  }),
  field(`#from-month-${String(n)}`, "From Month", {
    options: months,
    tag: "select",
    type: "select-one",
  }),
  field(`#from-year-${String(n)}`, "From Year"),
  field(`#to-month-${String(n)}`, "To Month", {
    options: months,
    tag: "select",
    type: "select-one",
  }),
  field(`#to-year-${String(n)}`, "To Year"),
  field(`#desc-${String(n)}`, "Role Description", {
    tag: "textarea",
    type: "textarea",
  }),
  field(`#reason-${String(n)}`, "Reason for leaving"),
];

const currentJob = {
  company: "Acme Capital",
  current: true,
  description: "Built models.",
  location: "New York, NY",
  startMonth: 3,
  startYear: 2022,
  title: "Analyst",
};

const pastJob = {
  company: "Beta Advisors",
  current: false,
  description: "",
  endMonth: 12,
  endYear: 2021,
  location: "Boston, MA",
  startMonth: 6,
  startYear: 2019,
  title: "Associate",
};

const degree = {
  current: false,
  degree: "BS",
  endMonth: 5,
  endYear: 2019,
  field: "Economics",
  school: "State University",
  startMonth: 9,
  startYear: 2015,
};

const profile = {
  ...emptyCandidateProfile,
  education: [degree],
  workHistory: [currentJob, pastJob],
};

const input = {
  applyUrl: "https://acme.wd5.myworkdayjobs.com/apply",
  browserSessionId: "browser-1",
  executionId: "exec-1",
  fieldsBefore: [field("#country", "Country")],
  profile,
};

const codesRun = () =>
  mocks.executePlaywright.mock.calls.map((call) => call[1].code);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.click.mockResolvedValue({
    clicked: true,
    errors: [],
    heading: "My Experience",
    href: "",
    navigated: false,
  });
  mocks.helper.mockResolvedValue({ blockers: [], fills: [] });
});

describe("mapping one profile entry onto a freshly added block", () => {
  it("places title, company, location, dates, and the current box by label", () => {
    const { fills, leftover } = mapEntryToBlock(workBlock(1), currentJob);
    expect(fills).toEqual(
      expect.arrayContaining([
        { selector: "#title-1", value: "Analyst" },
        { selector: "#company-1", value: "Acme Capital" },
        { selector: "#location-1", value: "New York, NY" },
        { selector: "#current-1", value: "yes" },
        {
          alternatives: ["03", "3", "Mar"],
          selector: "#from-month-1",
          value: "March",
        },
        { selector: "#from-year-1", value: "2022" },
        { selector: "#desc-1", value: "Built models." },
      ])
    );
    // A current position leaves the end date alone.
    expect(fills.map((fill) => fill.selector)).not.toContain("#to-month-1");
    expect(fills.map((fill) => fill.selector)).not.toContain("#to-year-1");
    expect(leftover.map((row) => row.selector)).toEqual(["#reason-1"]);
  });

  it("fills an end date for a finished position and an education block by its own labels", () => {
    const { fills } = mapEntryToBlock(workBlock(2), pastJob);
    expect(fills).toEqual(
      expect.arrayContaining([
        { selector: "#current-2", value: "no" },
        {
          alternatives: ["12", "12", "Dec"],
          selector: "#to-month-2",
          value: "December",
        },
        { selector: "#to-year-2", value: "2021" },
      ])
    );
    const education = mapEntryToBlock(
      [
        field("#school", "School or University*"),
        field("#degree", "Degree", {
          options: ["BA", "BS", "MBA"],
          tag: "select",
          type: "select-one",
        }),
        field("#major", "Field of Study"),
        field("#start", "Start Date", { type: "month" }),
        field("#end", "End Date", { type: "month" }),
      ],
      degree
    );
    expect(education.fills).toEqual([
      { selector: "#school", value: "State University" },
      { selector: "#degree", value: "BS" },
      { selector: "#major", value: "Economics" },
      { selector: "#start", value: "2015-09" },
      { selector: "#end", value: "2019-05" },
    ]);
  });

  it("takes unnamed date controls in page order, start before end", () => {
    const { fills } = mapEntryToBlock(
      [
        field("#m1", "Month", {
          options: months,
          tag: "select",
          type: "select-one",
        }),
        field("#y1", "Year"),
        field("#m2", "Month", {
          options: months,
          tag: "select",
          type: "select-one",
        }),
        field("#y2", "Year"),
      ],
      pastJob
    );
    expect(fills.map((fill) => [fill.selector, fill.value])).toEqual([
      ["#m1", "June"],
      ["#y1", "2019"],
      ["#m2", "December"],
      ["#y2", "2021"],
    ]);
  });
});

describe("growing a page's repeating sections", () => {
  const sections = (content: string) => ({
    sections: [{ content, heading: "Work Experience", index: 9, text: "Add" }],
  });

  it("presses Add once per entry, maps each new block, and asks the helper about the rest", async () => {
    let adds = 0;
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("const sections = await")) {
        return {
          result: sections(
            adds === 0
              ? "Work Experience Add"
              : adds === 1
                ? "Work Experience Analyst Acme Capital Add"
                : "Work Experience Analyst Acme Capital Associate Beta Advisors Add"
          ),
          success: true,
        };
      }
      if (request.code.includes("const fields = await")) {
        return {
          result: {
            fields: [
              field("#country", "Country"),
              ...workBlock(1),
              ...(adds === 2 ? workBlock(2) : []),
            ],
          },
          success: true,
        };
      }
      return {
        result: { filled: [], offered: [], skipped: [] },
        success: true,
      };
    });
    mocks.click.mockImplementation(async () => {
      adds += 1;
      return {
        clicked: true,
        errors: [],
        heading: "My Experience",
        href: "",
        navigated: false,
      };
    });
    mocks.helper.mockResolvedValue({
      blockers: [],
      fills: [{ selector: "#reason-1", value: "Growth" }],
    });

    const grown = await fillRepeaters(input);

    expect(mocks.click).toHaveBeenCalledTimes(2);
    expect(mocks.click.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ index: 9, text: "Add" })
    );
    expect(grown.map((row) => row.selector)).toEqual([
      ...workBlock(1).map((row) => row.selector),
      ...workBlock(2).map((row) => row.selector),
    ]);
    const applied = codesRun().filter((code) =>
      code.includes("const fills = ")
    );
    expect(applied[0]).toContain(
      '"selector":"#company-1","value":"Acme Capital"'
    );
    expect(applied[1]).toContain('"selector":"#reason-1","value":"Growth"');
    expect(applied[2]).toContain(
      '"selector":"#company-2","value":"Beta Advisors"'
    );
    // The helper sees only the one entry the block is for, never the profile.
    expect(mocks.helper).toHaveBeenCalledTimes(2);
    expect(mocks.helper.mock.calls[0]?.[0]?.profileSummary).toContain(
      "Acme Capital"
    );
    expect(mocks.helper.mock.calls[0]?.[0]?.profileSummary).not.toContain(
      "Beta Advisors"
    );
    expect(
      mocks.helper.mock.calls[0]?.[0]?.fields.map((row) => row.selector)
    ).toEqual(["#reason-1"]);
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        control: "Add",
        entry: 1,
        event: "runner.repeater",
        fields: 10,
        heading: "Work Experience",
        helper: 1,
        mapped: 7,
      })
    );
  });

  it("skips an entry the section already shows, so a second pass does not double up", async () => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("const sections = await")) {
        return {
          result: sections(
            "Work Experience Analyst Acme Capital 03/2022 - present Associate Beta Advisors Add"
          ),
          success: true,
        };
      }
      return {
        result: { fields: [field("#country", "Country")] },
        success: true,
      };
    });
    expect(await fillRepeaters(input)).toEqual([]);
    expect(mocks.click).not.toHaveBeenCalled();
  });

  it("leaves a section the profile has nothing for alone and says so", async () => {
    mocks.executePlaywright.mockImplementation(async () => ({
      result: {
        sections: [
          {
            content: "Languages Add",
            heading: "Languages",
            index: 3,
            text: "Add",
          },
          {
            content: "Work Experience Add",
            heading: "Work Experience",
            index: 9,
            text: "Add",
          },
        ],
      },
      success: true,
    }));
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("const sections = await")) {
        return {
          result: {
            sections: [
              {
                content: "Languages Add",
                heading: "Languages",
                index: 3,
                text: "Add",
              },
              {
                content: "Work Experience Add",
                heading: "Work Experience",
                index: 9,
                text: "Add",
              },
            ],
          },
          success: true,
        };
      }
      // Add pressed, nothing appeared.
      return {
        result: {
          fields: [field("#country", "Country")],
          filled: [],
          skipped: [],
        },
        success: true,
      };
    });
    await fillRepeaters(input);
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "runner.repeater_skipped",
        heading: "Languages",
      })
    );
    // One press that grew nothing ends the section.
    expect(mocks.click).toHaveBeenCalledTimes(1);
    expect(mocks.click.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ index: 9 })
    );
  });

  it("finds Add controls with the section they belong to, numbered like every other control", () => {
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    const collect = scripts.slice(
      scripts.indexOf("export const collectRepeaterSectionsCode"),
      scripts.indexOf("export const detectLoginWallCode")
    );
    expect(collect).toContain('"${pageControlsLocator}"');
    expect(collect).toContain("h1, h2, h3, h4, legend, [role=heading]");
  });
});
