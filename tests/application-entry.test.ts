import { describe, expect, it } from "vitest";
import { applicationEntryUrl } from "@/lib/application-runner/entry";

describe("where an application form lives", () => {
  it("opens Ashby and Lever postings at their forms, not their descriptions", () => {
    // Opened at the description, the runner scanned a page with no fields,
    // called the form filled, and sent the job description as the review.
    expect(
      applicationEntryUrl(
        "https://jobs.ashbyhq.com/latent/c140bfb6-0403-4bfe-b92b-71745139aa3d"
      )
    ).toBe(
      "https://jobs.ashbyhq.com/latent/c140bfb6-0403-4bfe-b92b-71745139aa3d/application"
    );
    expect(
      applicationEntryUrl(
        "https://jobs.lever.co/acme/1b2c3d4e-0403-4bfe-b92b-71745139aa3d?lever-source=x"
      )
    ).toBe(
      "https://jobs.lever.co/acme/1b2c3d4e-0403-4bfe-b92b-71745139aa3d/apply?lever-source=x"
    );
  });

  it("leaves a URL that already is the form, or belongs to another board, alone", () => {
    const form =
      "https://jobs.ashbyhq.com/latent/c140bfb6-0403-4bfe-b92b-71745139aa3d/application";
    expect(applicationEntryUrl(form)).toBe(form);
    const greenhouse =
      "https://job-boards.greenhouse.io/doordashusa/jobs/6333525";
    expect(applicationEntryUrl(greenhouse)).toBe(greenhouse);
    expect(applicationEntryUrl("not a url")).toBe("not a url");
  });
});
