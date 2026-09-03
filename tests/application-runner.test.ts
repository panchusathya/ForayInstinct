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
  mapProfileToFormFields,
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
    expect(mapped.fills).toEqual([{ selector: "#q", value: "Yes" }]);
    expect(mapped.unmapped).toEqual([]);
  });

  it("answers No when the candidate needs sponsorship", () => {
    const mapped = ask(
      "Are you authorized to work for any employer in the US?",
      ["Yes", "No"],
      "requires_sponsorship"
    );
    expect(mapped.fills).toEqual([{ selector: "#q", value: "No" }]);
  });

  it("still matches an option stated in the profile's own words", () => {
    const mapped = ask(
      "Work authorization",
      ["U.S. Citizen", "Permanent Resident", "Requires sponsorship"],
      "us_citizen"
    );
    expect(mapped.fills).toEqual([{ selector: "#q", value: "U.S. Citizen" }]);
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
