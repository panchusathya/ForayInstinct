import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { db } from "@/db";
import * as schema from "../db/schema";
import {
  type CandidateProfile,
  emptyCandidateProfile,
} from "@/lib/candidate-profile";
import {
  fillForAnswer,
  mapProfileToFormFields,
  matchFieldByLabel,
  profilePatchForAnswer,
  type VisibleFormField,
} from "@/lib/application-runner/form-map";
import { alreadyInProgressStatus } from "@/lib/task-completion";
import { clickSubmitCode } from "@/lib/application-runner/playwright-scripts";

const databases: PGlite[] = [];

afterEach(async () => {
  vi.doUnmock("@/db");
  vi.doUnmock("@/lib/application-runner/run");
  vi.doUnmock("@/db/services/default-resume");
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("application runner", () => {
  it("maps profile facts onto visible fields and leaves leftovers unmapped", () => {
    const fields: VisibleFormField[] = [
      {
        label: "Email",
        name: "email",
        required: true,
        selector: "#email",
        tag: "input",
        type: "email",
      },
      {
        label: "First name",
        name: "firstName",
        required: true,
        selector: "#first",
        tag: "input",
        type: "text",
      },
      {
        label: "Favorite color",
        name: "color",
        required: true,
        selector: "#color",
        tag: "input",
        type: "text",
      },
      {
        label: "Resume",
        name: "resume",
        required: true,
        selector: "#resume",
        tag: "file",
        type: "file",
      },
    ];
    const mapped = mapProfileToFormFields({
      fields,
      identity: { email: "ada@example.com", name: "Ada Lovelace", phone: "" },
      profile: {
        ...emptyCandidateProfile,
        legalFirstName: "Ada",
        legalLastName: "Lovelace",
      },
      resumePath: "/tmp/goforay-default-resume-ada.pdf",
    });
    expect(mapped.fills).toEqual(
      expect.arrayContaining([
        { selector: "#email", value: "ada@example.com" },
        { selector: "#first", value: "Ada" },
        { selector: "#resume", value: "/tmp/goforay-default-resume-ada.pdf" },
      ])
    );
    expect(mapped.unmapped).toEqual([
      expect.objectContaining({ selector: "#color", required: true }),
    ]);
  });

  it("refuses a second start_application while the lease is held", async () => {
    const { startApplication } = await setupStart();
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const applyUrl = "https://jobs.example/role/1";
    const first = await startApplication({
      applyUrl,
      company: "Example",
      role: "Analyst",
      rootSessionId: "root-1",
      scope: alice,
    });
    expect(first).toMatchObject({ pause: "approval", status: "waiting" });
    const second = await startApplication({
      applyUrl,
      company: "Example",
      role: "Analyst",
      rootSessionId: "root-1",
      scope: alice,
    });
    expect(second).toMatchObject({
      applyUrl,
      status: alreadyInProgressStatus,
    });
  });

  it("leaves no lease behind when the profile gate refuses a start", async () => {
    // The deadlock this gate is most at risk of: refuse above the lease, or the
    // retry it asks for comes back already_in_progress for twenty minutes.
    const { ensureScope, saveCandidateProfile, startApplication } =
      await setupStart();
    const bob = { userId: "bob", workspaceId: "workspace:bob" };
    await ensureScope(bob);
    const applyUrl = "https://jobs.example/role/2";
    const start = () =>
      startApplication({
        applyUrl,
        company: "Example",
        role: "Analyst",
        rootSessionId: "root-2",
        scope: bob,
      });

    expect(await start()).toMatchObject({ status: "needs_profile" });

    await saveCandidateProfile(bob, {
      legalFirstName: "Grace",
      legalLastName: "Hopper",
      requiresSponsorshipNow: "no",
      workAuthorization: "us_citizen",
      workHistory: [
        {
          company: "US Navy",
          current: false,
          description: "",
          location: "",
          startYear: 2018,
          title: "Rear Admiral",
        },
      ],
    });

    expect(await start()).toMatchObject({
      pause: "approval",
      status: "waiting",
    });
  });

  it("never clicks submit on the approval path", () => {
    const fill = readFileSync("lib/application-runner/fill.ts", "utf8");
    const approval = fill.slice(
      fill.indexOf("export async function captureApproval"),
      fill.indexOf("export async function submitApplication")
    );
    expect(approval).not.toContain("clickSubmitCode");
    expect(approval).not.toMatch(/\.click\(/);
    expect(fill).toContain("clickSubmitCode");
    expect(clickSubmitCode).toMatch(/getByRole\("button"/);
    const approvalTool = readFileSync(
      "agent/subagents/worker/tools/request_submission_approval.ts",
      "utf8"
    );
    expect(approvalTool).not.toMatch(
      /computer\.|\.click\(|playwright\.execute/
    );
  });

  it("does not spawn the Eve worker subagent", () => {
    for (const path of [
      "lib/application-runner/start.ts",
      "lib/application-runner/run.ts",
      "lib/application-runner/fill.ts",
      "lib/application-runner/workflow.ts",
      "agent/tools/start_application.ts",
      "agent/tools/continue_application.ts",
      "agent/tools/cancel_application.ts",
      "agent/instructions.md",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/defineAgent\(/);
      expect(source).not.toContain('name: "worker"');
      expect(source).not.toContain("computer_action");
    }
    const instructions = readFileSync("agent/instructions.md", "utf8");
    expect(instructions).toContain("start_application");
    expect(instructions).toContain("continue_application");
    expect(instructions).toContain("Never spawn the `worker` subagent");
  });
});

async function setupStart() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigration(client, "0000_fluffy_the_spike.sql");
  await applyMigration(client, "0009_candidate_profile.sql");
  await applyMigration(client, "0005_browser_run_checkpoints.sql");
  await applyMigration(client, "0019_application_execution_traces.sql");
  await applyMigration(client, "0021_application_leases.sql");
  await applyMigration(client, "0022_application_runner.sql");
  await applyMigration(client, "0023_little_sentinels.sql");

  const pgliteDatabase = drizzle(client, { schema });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- adapter-compatible integration test double
  const database = pgliteDatabase as unknown as typeof db;
  vi.doMock("@/db", () => ({ ...schema, db: database }));
  // The profile gate would otherwise refuse this start before any lease is
  // claimed, quietly turning a lease-contention test into a profile test.
  vi.doMock("@/db/services/default-resume", () => ({
    readOrImportDefaultResume: () => Promise.resolve(undefined),
  }));
  // An inline start drives the fill itself, so stub the browser-backed step and
  // leave this case to the lease contention it is actually about.
  vi.doMock("@/lib/application-runner/run", () => ({
    runApplicationUntilPause: (input: { applyUrl: string }) =>
      Promise.resolve({
        applyUrl: input.applyUrl,
        message: "Needs submission approval: Analyst",
        pause: "approval",
      }),
  }));

  const [scope, profiles, runner] = await Promise.all([
    import("@/db/services/scope"),
    import("@/db/services/candidate-profile"),
    import("@/lib/application-runner/start"),
  ]);
  const alice = { userId: "alice", workspaceId: "workspace:alice" };
  await scope.ensureScope(alice);
  await profiles.saveCandidateProfile(alice, {
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
    requiresSponsorshipNow: "no",
    workAuthorization: "us_citizen",
    workHistory: [
      {
        company: "Analytical Engines",
        current: false,
        description: "",
        location: "",
        startYear: 2015,
        title: "Mathematician",
      },
    ],
  });
  return {
    ensureScope: scope.ensureScope,
    saveCandidateProfile: profiles.saveCandidateProfile,
    startApplication: runner.startApplication,
  };
}

async function applyMigration(database: PGlite, name: string) {
  const migration = await readFile(
    new URL(`../db/migrations/${name}`, import.meta.url),
    "utf8"
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}

describe("option-based questions", () => {
  const ask = (
    label: string,
    options: string[],
    workAuthorization: CandidateProfile["workAuthorization"],
    requiresSponsorshipNow: CandidateProfile["requiresSponsorshipNow"] = "no"
  ) =>
    mapProfileToFormFields({
      fields: [
        {
          label,
          name: "q",
          options,
          required: true,
          selector: "#q",
          tag: "select",
          type: "select",
        },
      ],
      identity: { email: "ada@example.com", name: "Ada", phone: "" },
      profile: {
        ...emptyCandidateProfile,
        requiresSponsorshipNow,
        workAuthorization,
      },
    });

  it("answers a Yes/No work authorization question", () => {
    // The profile says "Authorized to work, no sponsorship needed" while the
    // posting only offers Yes/No, so the value used to match nothing and the
    // required question silently stayed blank.
    const mapped = ask(
      "Are you authorized to work for any employer in the US?",
      ["Yes", "No"],
      "us_visa_no_sponsorship"
    );
    expect(mapped.fills).toMatchObject([{ selector: "#q", value: "Yes" }]);
    expect(mapped.unmapped).toEqual([]);
  });

  it("answers No when the candidate needs sponsorship", () => {
    const mapped = ask(
      "Are you authorized to work for any employer in the US?",
      ["Yes", "No"],
      "requires_sponsorship"
    );
    expect(mapped.fills).toMatchObject([{ selector: "#q", value: "No" }]);
  });

  it("still matches an option stated in the profile's own words", () => {
    const mapped = ask(
      "Work authorization",
      ["U.S. Citizen", "Permanent Resident", "Requires sponsorship"],
      "us_citizen"
    );
    expect(mapped.fills).toMatchObject([
      { selector: "#q", value: "U.S. Citizen" },
    ]);
  });

  it("leaves a question it cannot answer for the candidate", () => {
    const mapped = ask(
      "Are you authorized to work for any employer in the US?",
      ["Green card", "TN visa", "H-1B"],
      "other"
    );
    expect(mapped.fills).toEqual([]);
    expect(mapped.unmapped).toHaveLength(1);
  });
});

describe("remembering an answer", () => {
  const field = (label: string, name = "q") => ({
    label,
    name,
    required: true,
    selector: "#q",
    tag: "input",
    type: "text",
  });

  it("keeps a name the candidate had to supply", () => {
    expect(profilePatchForAnswer(field("First Name"), "Sathya")).toEqual({
      legalFirstName: "Sathya",
    });
  });

  it("reads a work authorization answer back into the profile enum", () => {
    expect(
      profilePatchForAnswer(
        field("Are you authorized to work for any employer in the US?"),
        "Yes"
      )
    ).toEqual({ workAuthorization: "us_visa_no_sponsorship" });
    expect(
      profilePatchForAnswer(field("Work authorization"), "U.S. Citizen")
    ).toEqual({ workAuthorization: "us_citizen" });
  });

  it("turns a sponsorship answer into the stored yes/no", () => {
    expect(
      profilePatchForAnswer(field("Will you require sponsorship?"), "No")
    ).toEqual({ requiresSponsorshipNow: "no" });
  });

  it("never keeps a secret a form asked for", () => {
    expect(profilePatchForAnswer(field("Password"), "hunter2")).toBeUndefined();
    expect(
      profilePatchForAnswer(field("Social Security Number"), "000-00-0000")
    ).toBeUndefined();
    expect(
      profilePatchForAnswer(field("Date of Birth"), "1990-01-01")
    ).toBeUndefined();
  });

  it("keeps nothing from a question it does not recognize", () => {
    expect(
      profilePatchForAnswer(field("Favorite color"), "blue")
    ).toBeUndefined();
    expect(profilePatchForAnswer(field("First Name"), "  ")).toBeUndefined();
  });
});

describe("reading a control's label", () => {
  const script = readFileSync(
    "lib/application-runner/playwright-scripts.ts",
    "utf8"
  );

  it("resolves aria-labelledby, which is how a React form names a control", () => {
    // Without this a custom control reads as unlabelled, and an unlabelled
    // required field has no question to put to the candidate.
    expect(script).toContain("aria-labelledby");
    expect(script).toContain("document.getElementById(id)");
  });

  it("reads a label only from the control itself", () => {
    // An ancestor lookup returns a neighbouring field's text, which then
    // travels into every downstream decision as if the page had said it.
    expect(script).not.toMatch(
      /closest\("fieldset, \[role=group\], \[role=radiogroup\], div"\)/u
    );
  });
});

describe("closed-choice controls", () => {
  const script = readFileSync(
    "lib/application-runner/playwright-scripts.ts",
    "utf8"
  );

  it("reads a combobox's options after opening it, not at scan time", () => {
    // A react-select renders no listbox until opened, so scan-time options are
    // empty and the profile's own wording was matched against nothing.
    const combobox = script.slice(script.indexOf('role === "combobox"'));
    expect(combobox).toContain("await locator.click(");
    expect(combobox.indexOf("await locator.click(")).toBeLessThan(
      combobox.indexOf('page.$$eval("[role=option]"')
    );
  });

  it("never treats a combobox's inner input as its own field", () => {
    expect(script).toContain('node.closest("[role=combobox], [role=listbox]")');
  });

  it("offers Yes as an alternative for an authorized candidate", () => {
    const mapped = mapProfileToFormFields({
      fields: [
        {
          label: "Are you authorized to work for any employer in the U.S?",
          name: "q",
          options: [],
          required: true,
          selector: "#q",
          tag: "combobox",
          type: "text",
        },
      ],
      identity: { email: "ada@example.com", name: "Ada", phone: "" },
      profile: { ...emptyCandidateProfile, workAuthorization: "us_citizen" },
    });

    // The control cannot be read until it opens, so the fill carries every
    // phrasing that answers the question and matches against the live options.
    expect(mapped.fills[0]?.alternatives).toContain("Yes");
  });

  it("offers No when the candidate needs sponsorship", () => {
    const mapped = mapProfileToFormFields({
      fields: [
        {
          label: "Will you now or in the future require sponsorship?",
          name: "q",
          options: [],
          required: true,
          selector: "#q",
          tag: "combobox",
          type: "text",
        },
      ],
      identity: { email: "ada@example.com", name: "Ada", phone: "" },
      profile: { ...emptyCandidateProfile, requiresSponsorshipNow: "no" },
    });

    expect(mapped.fills[0]?.value).toBe("No");
  });
});

describe("contact email", () => {
  const emailField = (label: string) => ({
    label,
    name: "email",
    required: true,
    selector: "#email",
    tag: "input",
    type: "text",
  });

  const fill = (label: string, identityEmail?: string) =>
    mapProfileToFormFields({
      fields: [emailField(label)],
      identity: {
        name: "Ada",
        phone: "",
        ...(identityEmail ? { email: identityEmail } : {}),
      },
      profile: { ...emptyCandidateProfile, contactEmail: "sathya@example.com" },
    }).fills[0];

  it("falls back to the profile when there is no verified login email", () => {
    // An iMessage-only candidate has no Better Auth email, so this field had
    // nothing to draw on and was asked for on every posting.
    expect(fill("Email")?.value).toBe("sathya@example.com");
  });

  it("still prefers the verified address", () => {
    expect(fill("Email", "verified@example.com")?.value).toBe(
      "verified@example.com"
    );
  });

  it("recognizes a control labelled E-mail", () => {
    expect(fill("E-mail")?.value).toBe("sathya@example.com");
  });

  it("keeps an address the candidate typed", () => {
    expect(
      profilePatchForAnswer(emailField("Email"), "sathya@example.com")
    ).toEqual({ contactEmail: "sathya@example.com" });
  });

  it("keeps nothing that is not an address", () => {
    expect(
      profilePatchForAnswer(emailField("Email"), "not an email")
    ).toBeUndefined();
  });
});

describe("finding a question again by its label", () => {
  const workAuthField: VisibleFormField = {
    label: "Are you authorized to work for any employer in the U.S?*",
    name: "q1",
    options: [],
    required: true,
    selector: "(input)[7]",
    tag: "combobox",
    type: "text",
  };
  const linkedInField: VisibleFormField = {
    label: "LinkedIn Profile*",
    name: "q2",
    required: true,
    selector: "#linkedin",
    tag: "input",
    type: "text",
  };
  const fields = [workAuthField, linkedInField];

  it("ignores asterisks, case, and spacing", () => {
    expect(
      matchFieldByLabel(
        fields,
        "are you authorized to work for any employer in the u.s"
      )?.selector
    ).toBe("(input)[7]");
    expect(matchFieldByLabel(fields, "LinkedIn profile")?.selector).toBe(
      "#linkedin"
    );
  });

  it("refuses an ambiguous or unknown question", () => {
    expect(matchFieldByLabel(fields, "Favorite color")).toBeUndefined();
    expect(matchFieldByLabel(fields, "")).toBeUndefined();
  });

  it("turns an answer into a fill that bends onto the page's options", () => {
    const yesNo = { ...workAuthField, options: ["Yes", "No"] };

    expect(fillForAnswer(yesNo, "I am a U.S. citizen")).toMatchObject({
      selector: "(input)[7]",
      value: "Yes",
    });
    expect(fillForAnswer(workAuthField, "Yes")?.alternatives).toContain(
      "U.S. Citizen"
    );
    expect(fillForAnswer(linkedInField, "  ")).toBeUndefined();
  });
});

describe("a now-or-future sponsorship answer", () => {
  const field = {
    label:
      "Will you now or in the future require sponsorship for employment visa status?",
    name: "q3",
    required: true,
    selector: "#sponsor",
    tag: "combobox",
    type: "text",
  };

  it("settles both facts on a no", () => {
    expect(profilePatchForAnswer(field, "No")).toEqual({
      requiresSponsorshipFuture: "no",
      requiresSponsorshipNow: "no",
    });
  });

  it("commits only to the future on a yes", () => {
    // Needing sponsorship later says nothing about needing it today.
    expect(profilePatchForAnswer(field, "Yes")).toEqual({
      requiresSponsorshipFuture: "yes",
    });
  });
});

describe("the boilerplate every ATS asks", () => {
  const control = (label: string, options?: string[]): VisibleFormField => ({
    label,
    name: "",
    ...(options ? { options } : {}),
    required: true,
    selector: `#${label.replace(/\W+/gu, "-").toLowerCase()}`,
    tag: "combobox",
    type: "text",
  });

  const map = (
    fields: VisibleFormField[],
    selfIdentification: Record<string, string> = {}
  ) =>
    mapProfileToFormFields({
      fields,
      identity: { name: "Ada Lovelace" },
      profile: emptyCandidateProfile,
      selfIdentification,
    });

  it("declines a voluntary question rather than stalling the run", () => {
    // These are optional by law and always offer a decline, so asking the
    // candidate mid-fill spends a round trip on a question they may skip.
    const fields = [
      control("Gender", ["Male", "Female", "Decline to self identify"]),
      control("Race / Ethnicity", ["Asian", "I don't wish to answer"]),
      control("Veteran Status", ["Yes", "Prefer not to say"]),
      control("Disability Status", ["Yes", "No", "I do not wish to answer"]),
    ];

    const { fills, unmapped } = map(fields);

    expect(unmapped).toEqual([]);
    expect(fills.map((fill) => fill.value)).toEqual([
      "Decline to self identify",
      "I don't wish to answer",
      "Prefer not to say",
      "I do not wish to answer",
    ]);
  });

  it("uses the candidate's own answer once they have given one", () => {
    const { fills } = map([control("Gender", ["Male", "Female", "Decline"])], {
      gender: "Female",
    });

    expect(fills[0]?.value).toBe("Female");
  });

  it("agrees to an acknowledgement and to being contacted", () => {
    const fields = [
      control("Applicant Privacy Acknowledgement *", ["Yes", "No"]),
      control(
        "Would you like to receive communications via SMS and/or WhatsApp?",
        ["Yes", "No"]
      ),
      control("I agree to the terms", ["I agree", "I disagree"]),
    ];

    const { fills, unmapped } = map(fields);

    expect(unmapped).toEqual([]);
    expect(fills.map((fill) => fill.value)).toEqual(["Yes", "Yes", "I agree"]);
  });

  it("never answers a question about the candidate on their behalf", () => {
    // A permission is the candidate's standing instruction. A claim about
    // where they worked would be a statement they never made, on an
    // employer's form, under their name.
    const fields = [
      control("Have you worked at DoorDash?", ["Yes", "No"]),
      control("Are you a current or former employee?", ["Yes", "No"]),
      control("How did you hear about this role?", ["Referral", "Other"]),
    ];

    const { fills, unmapped } = map(fields);

    expect(fills).toEqual([]);
    expect(unmapped).toHaveLength(3);
  });
});

describe("a select-like widget's inner input", () => {
  const scripts = readFileSync(
    "lib/application-runner/playwright-scripts.ts",
    "utf8"
  );

  it("is skipped by both scans only when another element owns the combobox role", () => {
    // A react-select puts role=combobox on its typeahead input: that input is
    // the widget. A rule that skipped every input with aria-autocomplete
    // removed every dropdown on the DoorDash form from both scans at once, so
    // nothing filled them and nothing reported them blank, and the form went
    // to the candidate for approval with all of them empty.
    expect(scripts).not.toContain('hasAttribute("aria-autocomplete")');
    expect(scripts).not.toContain("/^react-select/");
    expect(
      scripts.match(/if \(isWidgetInterior\(node\)\) return \[\];/gu)
    ).toHaveLength(2);
  });

  it("never counts a control the page hides from assistive technology", () => {
    // The ten unlabelled required controls were react-select's invisible
    // <input required aria-hidden>, rendered beside each required select with
    // no value purely for constraint validation.
    expect(scripts).toContain('node.getAttribute("aria-hidden") === "true"');
    expect(
      scripts.match(/if \(!candidateFacing\(node\)\) return \[\];/gu)
    ).toHaveLength(2);
  });

  it("types into a typeahead that opens empty, then chooses a suggestion", () => {
    // Greenhouse's Location (City) shows nothing until something is typed, so
    // opening it and reading the list found no option on every run.
    const combobox = scripts.slice(scripts.indexOf('role === "combobox"'));
    const opened = combobox.indexOf("const shown = await liveOptions()");
    const typed = combobox.indexOf("await box.fill(value)");
    expect(opened).toBeGreaterThan(-1);
    expect(typed).toBeGreaterThan(opened);
    expect(combobox).toContain("shown.length === 0");
  });
});

describe("a link the candidate types once", () => {
  const field: VisibleFormField = {
    label: "LinkedIn Profile*",
    name: "",
    required: true,
    selector: "#li",
    tag: "input",
    type: "text",
  };

  it("is written to the profile so the next posting fills it", () => {
    // valueForField reads a link from the profile on every fill, but nothing
    // ever wrote one back, so this question returned on every application no
    // matter how many times it was answered.
    expect(
      profilePatchForAnswer(field, "linkedin.com/in/sathya-panchu")
    ).toEqual({
      links: [
        { label: "LinkedIn", url: "https://linkedin.com/in/sathya-panchu" },
      ],
    });
  });

  it("keeps the candidate's other links and replaces only its own", () => {
    const profile = {
      ...emptyCandidateProfile,
      links: [
        { label: "GitHub", url: "https://github.com/sathya" },
        { label: "LinkedIn", url: "https://linkedin.com/in/old" },
      ],
    };

    expect(
      profilePatchForAnswer(field, "https://linkedin.com/in/new", profile)
        ?.links
    ).toEqual([
      { label: "GitHub", url: "https://github.com/sathya" },
      { label: "LinkedIn", url: "https://linkedin.com/in/new" },
    ]);
  });

  it("keeps nothing that is not a link", () => {
    expect(profilePatchForAnswer(field, "ask me later")).toBeUndefined();
  });
});

describe("a Greenhouse form, as the DoorDash run saw it", () => {
  const combobox = (
    label: string,
    selector: string,
    required = true
  ): VisibleFormField => ({
    label,
    name: "",
    options: [],
    required,
    selector,
    tag: "combobox",
    type: "text",
  });
  const identity = { email: "ada@example.com", name: "Ada", phone: "" };
  const profile: CandidateProfile = {
    ...emptyCandidateProfile,
    locationCity: "San Francisco",
    locationRegion: "CA",
    requiresSponsorshipNow: "no",
    workAuthorization: "us_citizen",
  };

  it("answers an authorization question about the United States with Yes, not a state", () => {
    // "United States" matched the State field first, so the region was
    // offered as the answer to whether the candidate may work here.
    const { fills } = mapProfileToFormFields({
      fields: [
        combobox(
          "Are you legally authorized to work in the United States?*",
          "#q"
        ),
      ],
      identity,
      profile,
    });

    expect(fills[0]?.value).toBe("U.S. Citizen");
    expect(fills[0]?.alternatives).toContain("Yes");
    expect(fills[0]?.value).not.toBe("CA");
  });

  it("never stores a Yes to that question as the candidate's state", () => {
    const field = combobox(
      "Are you legally authorized to work in the United States?*",
      "#q"
    );

    expect(profilePatchForAnswer(field, "Yes")).toEqual({
      workAuthorization: "us_visa_no_sponsorship",
    });
    expect(profilePatchForAnswer(combobox("State*", "#s"), "CA")).toEqual({
      locationRegion: "CA",
    });
  });

  it("declines the Hispanic or Latino question like the rest of the EEO section", () => {
    const { fills, unmapped } = mapProfileToFormFields({
      fields: [combobox("Are you Hispanic or Latinx?*", "#q")],
      identity,
      profile,
    });

    expect(unmapped).toEqual([]);
    expect(fills[0]?.alternatives).toContain("I don't wish to answer");
  });

  it("never offers the candidate's gender as the answer to a transgender question", () => {
    const { fills } = mapProfileToFormFields({
      fields: [combobox("Do you identify as transgender?*", "#q")],
      identity,
      profile,
      selfIdentification: { gender: "Female" },
    });

    expect(fills[0]?.value).toBe("Decline to self identify");
    expect(fills[0]?.alternatives).not.toContain("Female");
  });

  it("puts the resume on the control asking for it, never in the cover letter slot", () => {
    const file = (label: string, selector: string, required: boolean) => ({
      label,
      name: "",
      required,
      selector,
      tag: "file",
      type: "file",
    });
    const { fills, unmapped } = mapProfileToFormFields({
      fields: [
        file("Resume/CV*", "#resume", true),
        file("Cover Letter", "#cover_letter", false),
      ],
      identity,
      profile,
      resumePath: "/tmp/goforay-default-resume-ada.pdf",
    });

    expect(fills).toEqual([
      { selector: "#resume", value: "/tmp/goforay-default-resume-ada.pdf" },
    ]);
    expect(unmapped).toEqual([]);
  });

  it("collects a file input the page hides behind an Attach button", () => {
    // Greenhouse never draws the file input, so a scan that only saw visible
    // controls never attached the resume and never noticed it was missing.
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    // Even one the page hides from assistive technology: the aria-hidden rule
    // is for react-select's decoy inputs, and the DoorDash form's resume slot
    // vanished from both scans under it.
    expect(scripts).toContain(
      "const candidateFacing = (node) => isFileInput(node) || (!assistiveHidden(node) && visible(node));"
    );
    expect(scripts).toContain(
      "blank = !(node.files && node.files.length > 0);"
    );
  });

  it("reports a resume slot it has no resume for, even one the DOM calls optional", () => {
    // Greenhouse validates the upload in script and puts the asterisk in a
    // label the input is not tied to, so `required` reads false. Dropping the
    // slot here is how the form reached submit and was refused for it.
    const { fills, unmapped } = mapProfileToFormFields({
      fields: [
        {
          label: "",
          name: "resume",
          required: false,
          selector: "#resume",
          tag: "file",
          type: "file",
        },
        {
          label: "Cover Letter",
          name: "cover_letter",
          required: false,
          selector: "#cover_letter",
          tag: "file",
          type: "file",
        },
      ],
      identity,
      profile,
    });
    expect(fills).toEqual([]);
    expect(unmapped.map((field) => field.selector)).toEqual(["#resume"]);
  });

  it("recognizes a resume slot by its id when nothing else names it", () => {
    // The DoorDash attach ran with no scanned selector: the slot's label was
    // not tied to the input and its name was blank, so nothing but the id
    // said what it was for, and a form with a cover-letter slot beside it had
    // two file inputs and no rule to pick between them.
    const { fills } = mapProfileToFormFields({
      fields: [
        {
          label: "",
          name: "",
          required: false,
          selector: "#resume-upload",
          tag: "file",
          type: "file",
        },
        {
          label: "",
          name: "",
          required: false,
          selector: "#cover-letter-upload",
          tag: "file",
          type: "file",
        },
      ],
      identity,
      profile,
      resumePath: "/tmp/goforay-default-resume-ada.pdf",
    });
    expect(fills).toEqual([
      {
        selector: "#resume-upload",
        value: "/tmp/goforay-default-resume-ada.pdf",
      },
    ]);
  });

  it("never hands the resume to a lone cover letter slot", () => {
    // Round two on DoorDash: Greenhouse had swapped the resume input for the
    // filename, the cover letter slot was the only file input left, and the
    // lone-input rule put the resume there too.
    const { fills, unmapped } = mapProfileToFormFields({
      fields: [
        {
          label: "Attach",
          name: "",
          required: false,
          selector: "#cover_letter",
          tag: "file",
          type: "file",
        },
      ],
      identity,
      profile,
      resumePath: "/tmp/goforay-default-resume-ada.pdf",
    });
    expect(fills).toEqual([]);
    expect(unmapped).toEqual([]);
  });

  it("finds the slot itself and proves the file landed", () => {
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    const attach = scripts.slice(
      scripts.indexOf("export const attachFileCode")
    );
    // Done is done: a page already showing the filename gets no second
    // attach, and no search for whatever slot is left.
    expect(attach.indexOf('found: "already-attached"')).toBeLessThan(
      attach.indexOf('page.locator("input[type=file]")')
    );
    // A scanned selector that is gone falls back to the page's own wording,
    // then to a lone file input, never one that names another document.
    expect(attach).toContain('page.locator("input[type=file]")');
    expect(attach).toContain("!otherDocument.test(described[0].own)");
    // The routes run in the caller's order, and each is checked against the
    // control before the next: a path the browser's machine cannot see is
    // accepted and attaches nothing, which is how the resume never reached
    // DoorDash through the gateway.
    expect(attach).toContain("for (const method of order)");
    expect(attach).toContain('Buffer.from(payload.base64, "base64")');
    expect(attach).toContain("accepted but the control holds no file");
    // A last route with no Playwright file plumbing at all.
    expect(attach).toContain("new DataTransfer()");
    expect(attach).toContain(
      'node.dispatchEvent(new Event("change", { bubbles: true }))'
    );
    // Every remote call carries its own timeout, so a hung browser returns a
    // reason instead of the gateway's silent thirty-second kill.
    expect(attach).toContain("{ timeout: 8000 }");
    expect(attach).toContain("const brief = { timeout: 2000 };");
    // The control's own word, never the call's: the file still held, or the
    // page showing its name after taking it. An ATS that uploads on change
    // clears the input straight after, and reading files alone called that
    // success a failure on the DoorDash form.
    expect(attach).toContain("node.files ? node.files.length : 0");
    expect(attach).toContain("text.includes(expected)");
    // A failure names the page's file inputs by their own wording so the log
    // says which control this was, and never the file.
    expect(attach).toContain('page.$$eval("input[type=file]"');
  });
});

describe("a verification code dialog", () => {
  const scripts = readFileSync(
    "lib/application-runner/playwright-scripts.ts",
    "utf8"
  );

  it("recognizes a dialog made of small boxes whatever they are called", () => {
    // Greenhouse's are #security-input-1 .. 7, type=text, no label, no
    // autocomplete=one-time-code; nothing in their attributes says code.
    expect(scripts).toContain(
      "/one-time-code|otp|verif|passcode|\\\\bcode\\\\b|numeric|\\\\bpin\\\\b|security|token|digit/"
    );
    expect(scripts).toContain(
      'String(node.getAttribute("maxlength") || "") === "1"'
    );
    expect(scripts).toContain("length >= 3");
    // Wording still has to say verification: a zip code is numeric too.
    expect(scripts).toContain("codeContext.test((contextOf(node).innerText");
  });

  it("types a box dialog character by character", () => {
    const enter = scripts.slice(
      scripts.indexOf("export const enterVerificationCodeCode")
    );
    expect(enter).toContain("await page.keyboard.type(code, { delay: 40 })");
    expect(enter).toContain("await first.fill(code, { timeout: 4000 })");
  });
});

describe("the submit click", () => {
  it("prefers the form's own submit control over any button named Apply", () => {
    // The DoorDash submit reported clicked: true, navigated: false, errors:
    // none. A posting page can carry other buttons whose names say Apply, and
    // `.first()` on the name match takes whichever comes first in the DOM.
    expect(clickSubmitCode).toContain("form button[type=submit]");
    expect(clickSubmitCode.indexOf("form button[type=submit]")).toBeLessThan(
      clickSubmitCode.indexOf("/apply|send application/i")
    );
    expect(
      clickSubmitCode.indexOf("/submit application|submit/i")
    ).toBeLessThan(clickSubmitCode.indexOf("/apply|send application/i"));
  });
});
