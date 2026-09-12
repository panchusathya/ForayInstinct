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
  phoneRenderings,
  profilePatchForAnswer,
  type VisibleFormField,
} from "@/lib/application-runner/form-map";
import { alreadyInProgressStatus } from "@/lib/task-completion";
import {
  applyFillsCode,
  clickSubmitCode,
  collectEmptyRequiredFieldsCode,
  collectVisibleFieldsCode,
  reachApplicationFormCode,
} from "@/lib/application-runner/playwright-scripts";

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
  }, 15_000);

  it("releases the lease when the run throws, so the retry it asks for is not refused", async () => {
    // A Workday run that died on its first gateway call kept its lease, and
    // the "send the posting again" it answered with came back
    // already_in_progress until the watchdog reached the lease.
    const { startApplication } = await setupStart({
      run: () =>
        Promise.reject(
          new Error(
            "Browser gateway did not answer POST /sessions/x/playwright within 55s."
          )
        ),
    });
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const applyUrl = "https://jobs.example/role/3";
    const start = () =>
      startApplication({
        applyUrl,
        company: "Example",
        role: "Analyst",
        rootSessionId: "root-3",
        scope: alice,
      });

    expect(await start()).toMatchObject({
      pause: "user_input",
      status: "failed",
    });
    const retry = await start();
    expect(retry.status).not.toBe(alreadyInProgressStatus);
    expect(retry).toMatchObject({ status: "failed" });
  }, 15_000);

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
  }, 15_000);

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

async function setupStart(options: { run?: () => Promise<unknown> } = {}) {
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
  await applyMigration(client, "0001_better-auth.sql");
  await applyMigration(client, "0027_adoption_and_phone_scope.sql");

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
    runApplicationUntilPause:
      options.run ??
      ((input: { applyUrl: string }) =>
        Promise.resolve({
          applyUrl: input.applyUrl,
          message: "Needs submission approval: Analyst",
          pause: "approval",
        })),
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

describe("a region against a list of states", () => {
  const region = (value: string, options: string[]) =>
    mapProfileToFormFields({
      fields: [
        {
          label: "State*",
          name: "state",
          options,
          required: true,
          selector: "#state",
          tag: "select",
          type: "select",
        },
      ],
      identity: { email: "ada@example.com", name: "Ada", phone: "" },
      profile: { ...emptyCandidateProfile, locationRegion: value },
    });

  it("takes the state the abbreviation names, not the first that begins with it", () => {
    // "MA" begins Maine, Maryland and Massachusetts; Maine was sent.
    const { fills } = region("MA", ["Maine", "Maryland", "Massachusetts"]);
    expect(fills[0]?.value).toBe("Massachusetts");
    const back = region("Massachusetts", ["CA", "MA", "NY"]);
    expect(back.fills[0]?.value).toBe("MA");
  });

  it("uses a prefix only when it settles the choice", () => {
    expect(
      region("Mass", ["Maine", "Maryland", "Massachusetts"]).fills[0]?.value
    ).toBe("Massachusetts");
    const ambiguous = region("New", ["New Jersey", "New York"]);
    expect(ambiguous.fills).toHaveLength(0);
    expect(ambiguous.unmapped).toHaveLength(1);
  });
});

describe("questions that only sound like contact details", () => {
  const mapped = (label: string) =>
    mapProfileToFormFields({
      fields: [
        {
          label,
          name: "q",
          required: true,
          selector: "#q",
          tag: "input",
          type: "text",
        },
      ],
      identity: {
        email: "ada@example.com",
        name: "Ada",
        phone: "+14155550100",
      },
      profile: {
        ...emptyCandidateProfile,
        earliestStartDate: "2026-10-01",
        locationCity: "Boston",
      },
    });

  it("does not type a phone number, a city, or a start date into them", () => {
    // Each of these was answered with the matching profile fact.
    for (const label of [
      "Are you open to telecommuting?",
      "In what capacity did you work with them?",
      "Are you available to work weekends?",
    ]) {
      const { fills, unmapped } = mapped(label);
      expect({ fills: fills.length, label, unmapped: unmapped.length }).toEqual(
        {
          fills: 0,
          label,
          unmapped: 1,
        }
      );
    }
    expect(mapped("Phone").fills[0]?.value).toBe("4155550100");
    expect(mapped("City").fills[0]?.value).toBe("Boston");
    expect(mapped("Earliest available start date").fills[0]?.value).toBe(
      "2026-10-01"
    );
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

  it("reads a caption the page binds another way, from the field's own entry only", () => {
    // Ashby binds label[for] to the field key, Lever puts the question in a
    // sibling div, Rippling names inputs by aria-labelledby. The entry walk
    // stops at any ancestor holding another field, so the page's "* indicates
    // a required field" note can never become a control's caption.
    const helpers = script.slice(
      script.indexOf("const captionFor ="),
      script.indexOf("const ownLabel =")
    );
    const order = [
      "labelledByElements(node)",
      "labelForId(node)",
      'node.closest("label")',
      "labelForName(node)",
      "fieldCaption([node]",
    ].map((step) => helpers.indexOf(step));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(script).toContain(
      "if (foreignControls(ancestor, own).length > 0) break;"
    );
    expect(script).toContain(
      "if (forId && byId(element, forId)) return false;"
    );
  });

  it("sees every way a page draws the required mark", () => {
    // Lever's ✱, Ashby's CSS ::after star and _required_ class, Paylocity's
    // "(required)", Rippling's star in a sibling span beside the label.
    expect(script).toContain("const STAR = /[*\\\\u2731\\\\u2217\\\\uFF0A]/;");
    expect(script).toContain('getComputedStyle(element, "::after").content');
    expect(script).toContain("REQUIRED_WORD.test(text)");
    expect(script).toContain("OPTIONAL_WORD.test(caption.text)) return false;");
    const required = script.slice(
      script.indexOf("const captionRequired ="),
      script.indexOf("const isRequired =")
    );
    expect(required).toContain("foreignControls(entry, own).length === 0");
  });
});

describe("a choice group, however the page draws it", () => {
  const script = readFileSync(
    "lib/application-runner/playwright-scripts.ts",
    "utf8"
  );

  it("collects radios, role=radio elements, switches and aria-pressed buttons as one model", () => {
    // Ashby's Yes/No is two aria-pressed buttons over a hidden checkbox;
    // Workable and Rippling draw role=radio elements over hidden native radios.
    expect(script).toContain(
      '"input[type=radio], input[type=checkbox], [role=radio], [role=checkbox], [role=switch], button[aria-pressed]"'
    );
    expect(script).toContain(
      '(tag === "button" && node.hasAttribute("aria-pressed"))'
    );
    expect(script).toContain("const choiceGroupOf = (node) =>");
    // Both scans use it, and read it before the visibility test, because the
    // native control behind a styled option is hidden while its proxy shows.
    expect(script.match(/const group = choiceGroupOf\(node\);/gu)).toHaveLength(
      2
    );
    expect(script).not.toContain(
      'node.closest("fieldset, [role=radiogroup]");'
    );
  });

  it("names a group by its legend, a label bound to nothing, or its entry, never an option", () => {
    const caption = script.slice(
      script.indexOf("const groupCaption ="),
      script.indexOf("const choiceGroupOf =")
    );
    expect(caption.indexOf("labelledByText(container)")).toBeLessThan(
      caption.indexOf('container.querySelector("legend")')
    );
    expect(caption.indexOf('container.querySelector("legend")')).toBeLessThan(
      caption.indexOf("captionElementIn(container, own)")
    );
    expect(caption).toContain("fieldCaption(");
    expect(script).not.toContain('group.querySelector("legend, label")');
  });

  it("chooses an option by clicking what a person would, and trusts only the page's state", () => {
    const fill = script.slice(script.indexOf("const choose = async (option)"));
    expect(fill.indexOf("(proxy || node).click();")).toBeLessThan(
      fill.indexOf("option.click({ timeout: 3000 })")
    );
    expect(fill.indexOf("option.click({ timeout: 3000 })")).toBeLessThan(
      fill.indexOf("option.click({ force: true, timeout: 3000 })")
    );
    expect(fill).toContain("if (await isOn(option)) return true;");
    expect(fill).toContain('reason: "no-option"');
    expect(script).not.toContain("await option.check();");
  });

  it("reports a blank required group with the page's own choices", () => {
    const blank = script.slice(
      script.indexOf("export const collectEmptyRequiredFieldsCode")
    );
    expect(blank).toContain(
      "if (group.members.some((member) => optionChecked(member))) return [];"
    );
    expect(blank).toContain("options: group.members.length > 1");
    // The combobox blank test reads the widget's own entry, never a neighbour.
    expect(blank).toContain(
      "foreignControls(ancestor, [node]).length > 0) break;"
    );
  });

  it("treats a list control by its behaviour, not only its role", () => {
    // Rippling's location input autocompletes from a listbox and has no role;
    // Workday opens its lists from a button.
    expect(script).toContain('tag === "button" && haspopup === "listbox"');
    expect(script).toContain(
      'String(node.getAttribute("aria-autocomplete") || "").toLowerCase() === "list"'
    );
    expect(script).toContain(
      "input[aria-autocomplete=list], input[aria-haspopup=listbox]"
    );
    // A hidden combobox shell owns nothing; a cookie banner's switches are not the form.
    expect(script).toContain("owner !== node && visible(owner)");
    expect(script).toContain("const inConsentBanner = (node) =>");
  });

  it("answers a Yes/No radio group from the profile and asks about one it cannot", () => {
    const radio = (label: string, options: string[]): VisibleFormField => ({
      label,
      name: "",
      options,
      required: true,
      selector: '[data-foray-id="g1"]',
      tag: "radio",
      type: "radio",
    });
    const identity = { email: "ada@example.com", name: "Ada", phone: "" };
    const profile = {
      ...emptyCandidateProfile,
      requiresSponsorshipNow: "no" as const,
      workAuthorization: "us_citizen" as const,
    };
    const answered = mapProfileToFormFields({
      fields: [
        radio("Are you legally authorized to work in the United States?", [
          "Yes",
          "No",
        ]),
        radio(
          "Lambda may agree to sponsor individuals to obtain work authorization. Will you require sponsorship?",
          ["Yes", "No"]
        ),
      ],
      identity,
      profile,
    });
    expect(answered.fills.map((fill) => fill.value)).toEqual(["Yes", "No"]);
    expect(answered.unmapped).toEqual([]);

    const asked = mapProfileToFormFields({
      fields: [
        radio("Have you completed a data center acquisition?", ["Yes", "No"]),
      ],
      identity,
      profile,
    });
    expect(asked.fills).toEqual([]);
    expect(asked.unmapped).toHaveLength(1);
  });

  it("types the profile city into a Location typeahead, with the region as an alternative", () => {
    const { fills } = mapProfileToFormFields({
      fields: [
        {
          label: "Location",
          name: "",
          options: [],
          required: true,
          selector: '[data-foray-id="loc"]',
          tag: "combobox",
          type: "text",
        },
      ],
      identity: { email: "ada@example.com", name: "Ada", phone: "" },
      profile: {
        ...emptyCandidateProfile,
        locationCity: "San Francisco",
        locationRegion: "CA",
      },
    });
    expect(fills[0]?.value).toBe("San Francisco");
    expect(fills[0]?.alternatives).toContain("San Francisco, California");
  });

  it("ticks a confirmation worded as the candidate's own declaration", () => {
    // OpenAI's form ends on a box labelled only "I confirm I have read the
    // above." It matched none of the consent wording, so it was neither
    // filled nor asked about, and the submit came back refused.
    const identity = { email: "ada@example.com", name: "Ada", phone: "" };
    for (const label of [
      "I confirm I have read the above.",
      "I hereby certify that I have not knowingly withheld any information",
      "I acknowledge that I have opened, read, and understood the Arbitration Agreement",
      "I have read and understood the privacy notice",
    ]) {
      const { fills } = mapProfileToFormFields({
        fields: [
          {
            label,
            name: label,
            options: [],
            required: false,
            selector: '[data-foray-id="c1"]',
            tag: "checkbox",
            type: "checkbox",
          },
        ],
        identity,
        profile: emptyCandidateProfile,
      });
      expect(fills[0]?.value).toBe("Yes");
    }
  });

  it("never answers a question about the candidate as though it were a consent", () => {
    // The boundary the consent rule exists to hold: a permission may be given
    // on their behalf, a claim about them never may.
    const identity = { email: "ada@example.com", name: "Ada", phone: "" };
    for (const label of [
      "Have you read our engineering blog?",
      "Have you worked at OpenAI before?",
      "Were you referred by an employee?",
    ]) {
      const { fills } = mapProfileToFormFields({
        fields: [
          {
            label,
            name: "",
            options: ["Yes", "No"],
            required: true,
            selector: '[data-foray-id="q1"]',
            tag: "radio",
            type: "radio",
          },
        ],
        identity,
        profile: emptyCandidateProfile,
      });
      expect(fills).toEqual([]);
    }
  });

  it("reads a start date asked as a question, not only as a label", () => {
    // "When can you start a new role?" is the same question as "Start date",
    // and matched neither pattern, so a stored date went unoffered and the
    // run stopped to ask for one it already had.
    for (const label of [
      "When can you start a new role?",
      "How soon can you start?",
      "Notice period",
      "Start date",
    ]) {
      const { fills } = mapProfileToFormFields({
        fields: [
          {
            label,
            name: "",
            options: [],
            required: true,
            selector: "#d",
            tag: "input",
            type: "text",
          },
        ],
        identity: { email: "ada@example.com", name: "Ada", phone: "" },
        profile: { ...emptyCandidateProfile, earliestStartDate: "10/01/2026" },
      });
      expect(fills[0]?.value).toBe("10/01/2026");
    }
  });

  it("reports a value the control did not keep, rather than counting it filled", () => {
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    expect(scripts).toContain('reason: "not-accepted"');
    expect(scripts).toContain("await locator.inputValue()");
    const fill = readFileSync("lib/application-runner/fill.ts", "utf8");
    expect(fill).toContain('row.reason === "not-accepted"');
    expect(fill).toContain("runner.value_not_kept");
  });

  it("ticks one consent box by its label, and only calls it ticked once the page agrees", () => {
    // A box drawn at opacity 0 under its own styled label is one check() can
    // refuse for not receiving pointer events, and the branch used to report
    // every checkbox filled whether the click landed or not: a consent left
    // unticked came back as a submit the page refused.
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    const opens = scripts.indexOf(
      'if (type === "checkbox" || (shape && shape.kind ==='
    );
    const branch = scripts.slice(
      opens,
      scripts.indexOf('if (tag === "select")', opens)
    );
    expect(branch).toContain("proxy.click()");
    expect(branch.indexOf("proxy.click()")).toBeLessThan(
      branch.indexOf("locator.check({ timeout: 3000 })")
    );
    expect(branch.indexOf("locator.check({ timeout: 3000 })")).toBeLessThan(
      branch.indexOf("force: true")
    );
    expect(branch).toContain("if (state === on) filled.push(fill.selector)");
    expect(branch).toContain('reason: "not-accepted"');
  });

  it("never sends the candidate to the form to change something themselves", () => {
    // The runner holds the only browser on that form, so a change made in
    // the candidate's own browser reaches nothing.
    const instructions = readFileSync("agent/instructions.md", "utf8");
    expect(instructions).toContain(
      "Never tell the candidate to open the posting and fill, fix, or finish anything"
    );
    expect(instructions).toContain(
      "continue_application` with that `apply_url"
    );
  });

  it("never types the home city into a question about the office", () => {
    const { fills, unmapped } = mapProfileToFormFields({
      fields: [
        {
          label:
            "Are you able and willing to work onsite at our San Francisco/San Jose location 4 days a week?",
          name: "",
          options: ["Yes", "No"],
          required: true,
          selector: '[data-foray-id="g2"]',
          tag: "radio",
          type: "radio",
        },
      ],
      identity: { email: "ada@example.com", name: "Ada", phone: "" },
      profile: { ...emptyCandidateProfile, locationCity: "San Francisco" },
    });
    expect(fills).toEqual([]);
    expect(unmapped).toHaveLength(1);
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
      combobox.indexOf('optionRoot.locator("[role=option]")')
    );
  });

  it("picks options from the widget's own list, and gives up on one in time", () => {
    // Two open lists on a page could swap options, and an option that never
    // became clickable held the batch past its budget.
    const combobox = script.slice(script.indexOf('role === "combobox"'));
    expect(combobox).toContain('getAttribute("aria-controls")');
    expect(combobox).toContain(
      'optionRoot.getByRole("option", { name: wanted, exact: true }).first().click({ timeout: 5000 })'
    );
  });

  it("marks a control with no id or name so its selector survives a re-scan", () => {
    expect(script).toContain('node.setAttribute("data-foray-id", stamp)');
    expect(script).not.toContain(
      'return "(" + node.tagName.toLowerCase() + ")["'
    );
    expect(script).toContain(
      'scope.setAttribute("data-foray-section", section)'
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

describe("a phone number for a form", () => {
  it("offers the national digits first and the stored international shape last", () => {
    // The stored +1 shape is the one the DoorDash form refused: "Please enter
    // a valid phone." The number the candidate typed by hand went through.
    expect(phoneRenderings("+14155550100")).toEqual([
      "4155550100",
      "(415) 555-0100",
      "+14155550100",
    ]);
    expect(phoneRenderings("(415) 555-0100")).toEqual([
      "4155550100",
      "(415) 555-0100",
      "+14155550100",
    ]);
    expect(phoneRenderings("+442071234567")).toEqual([
      "+442071234567",
      "442071234567",
    ]);
  });

  it("fills a tel control with the national digits and carries the other shapes", () => {
    const identity = {
      email: "ada@example.com",
      name: "Ada",
      phone: "+14155550100",
    };
    const profile: CandidateProfile = { ...emptyCandidateProfile };
    const { fills } = mapProfileToFormFields({
      fields: [
        {
          label: "Phone*",
          name: "phone",
          required: true,
          selector: "#phone",
          tag: "input",
          type: "tel",
        },
      ],
      identity,
      profile,
    });
    expect(fills).toEqual([
      {
        alternatives: ["(415) 555-0100", "+14155550100"],
        selector: "#phone",
        value: "4155550100",
      },
    ]);
  });

  it("types a phone number keystroke by keystroke", () => {
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    expect(scripts).toContain(
      "await locator.pressSequentially(fill.value, { delay: 20 });"
    );
  });
});

describe("reaching the application form", () => {
  it("compares registrable domains, so two .co.uk sites are not one site", () => {
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    const reach = scripts.slice(
      scripts.indexOf("export const reachApplicationFormCode")
    );
    expect(reach).toContain("twoPartTlds.has(labels.slice(-2)");
    expect(scripts).toContain("twoPartTldList");
  });

  it("keeps the DOM attach route open when the payload cannot be built", () => {
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    const attach = scripts.slice(
      scripts.indexOf("export const attachFileCode"),
      scripts.indexOf("const codeInputHelpers")
    );
    expect(attach).toContain(
      'attempts.push("payload: " + describeError(error))'
    );
    expect(attach.indexOf('attempts.push("payload: "')).toBeLessThan(
      attach.indexOf("await domAttach()")
    );
  });

  it("follows the page's Apply control on the same site and reports another site", () => {
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    const reach = scripts.slice(
      scripts.indexOf("export const reachApplicationFormCode")
    );
    // Two fillable controls or a file slot is a form; anything less is a
    // description page whose Apply control is what to open.
    expect(reach).toContain("found.count >= 2 || found.files > 0");
    // A cross-site link is handed back, never followed: the browser is pinned
    // to one site.
    expect(reach).toContain("external: target.href");
    expect(reach.indexOf("external: target.href")).toBeLessThan(
      reach.indexOf("await page.goto(target.href")
    );
  });

  it("waits for a client-rendered form and treats the page's own tab as a click, not a reload", () => {
    // Ashby paints its fields seconds after domcontentloaded and switches to
    // them through an "Application" tab whose href is the page already open.
    // Reloading that URL through the proxy outran the gateway's budget.
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    const reach = scripts.slice(
      scripts.indexOf("export const reachApplicationFormCode")
    );
    expect(reach).toContain("let before = await settle(20000)");
    expect(reach).toContain(
      '"a, button, [role=button], [role=tab], [role=link]"'
    );
    expect(reach).toContain("tabWording");
    expect(reach).toContain('node.closest("a")');
    expect(reach).toContain("if (samePage) {");
    expect(reach.indexOf("if (samePage) {")).toBeLessThan(
      reach.indexOf("await page.goto(target.href")
    );
    // Every wait is drawn from one budget, so a page that never renders is
    // reported by this script rather than killed by the gateway mid-wait.
    expect(reach).toContain("const left = (want) =>");
    expect(reach).not.toContain("timeout: 30000");
    expect(reach).toContain("const after = await settle(20000)");
    expect(reach.match(/timeout: left\(/gu)?.length ?? 0).toBeGreaterThan(4);
  });

  it("waits for the page's own fetches, and reloads a shell that rendered nothing", () => {
    // An open OpenAI posting on Ashby came back with zero fillable controls:
    // its form is fetched after load, and a first load that lost those
    // fetches keeps an empty shell for good.
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    const reach = scripts.slice(
      scripts.indexOf("export const reachApplicationFormCode")
    );
    expect(reach).toContain('page.waitForLoadState("networkidle"');
    expect(reach).toContain("if (controls.length === 0 && before.count === 0)");
    expect(reach).toContain("await page.reload(");
    // Only as a last resort: a description page with an Apply control is
    // followed rather than reloaded.
    expect(reach.indexOf("let controls = await findControls()")).toBeLessThan(
      reach.indexOf("await page.reload(")
    );
    expect(reach.indexOf("await page.reload(")).toBeLessThan(
      reach.indexOf("const chosen = controls.find(")
    );
  });

  it("brings back the page's own words when it holds no form", () => {
    // A deleted posting and a form that never rendered were one log line and
    // one message, so neither could be told from a page the runner misread.
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    const reach = scripts.slice(
      scripts.indexOf("export const reachApplicationFormCode")
    );
    expect(reach).toContain("const evidence = () => page.evaluate(");
    expect(reach).toContain("page: await evidence()");
    expect(reach).toContain("controls: 0, page: await evidence()");
    const fill = readFileSync("lib/application-runner/fill.ts", "utf8");
    expect(fill).toContain("page_heading: reach.page.heading");
    expect(fill).toContain("isUnavailablePostingText(words)");
  });

  it("matches a typeahead's suggestions against every phrasing, at a comma", () => {
    // Greenhouse answered "San Francisco" with five places that all begin
    // with it, so the typed text alone read as ambiguous; the profile's own
    // "San Francisco, California" names exactly one of them.
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    expect(scripts).toContain("wanted = matchOption(live, wantedList(fill))");
    expect(scripts).not.toContain("wanted = matchOption(live, [value])");
    expect(scripts).toContain('startsWith(wanted + ",")');
    // The highlighted suggestion is trusted only where it continues the typed
    // text at a comma: "San Francisco Del Yeso, Amazonas, Peru" is not it.
    expect(scripts).toContain('shown.startsWith(typed + ",")');
  });

  it("compiles as the statement block the gateway wraps it in", () => {
    // The gateway builds an AsyncFunction from this text (eval.ts). A syntax
    // slip in the template would fail every run, and only in production.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript's lib does not expose the AsyncFunction constructor.
    const AsyncFunction = (async () => undefined).constructor as new (
      ...args: string[]
    ) => unknown;
    for (const code of [
      reachApplicationFormCode,
      collectVisibleFieldsCode,
      collectEmptyRequiredFieldsCode,
      applyFillsCode([
        { alternatives: ["Yes"], selector: "#q", value: "U.S. Citizen" },
      ]),
    ]) {
      expect(
        () => new AsyncFunction("browser", "page", "context", code)
      ).not.toThrow();
    }
  });
});

describe("what an unlabelled field's surroundings may say", () => {
  it("reads the group's caption, never a div that spans the neighbours' answers", () => {
    // A div ancestor carried the veteran status and ethnicity already chosen
    // in the EEO fieldset into the runner.unlabelled_field log.
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    expect(scripts).not.toContain(
      'node.closest("fieldset, [role=group], div")'
    );
    expect(scripts).toContain(
      'wrapper.querySelector("legend, [role=heading], h1, h2, h3, h4, label")'
    );
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
    // The context is the nearest enclosure that could be the dialog asking,
    // never the whole page, and a zip or country code is not a code box.
    expect(scripts).not.toContain(
      'node.closest("[role=dialog], dialog, form, section, main") || document.body'
    );
    expect(scripts).toContain(
      "const notACode = /country|zip|postal|dial|area|phone|address"
    );
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
