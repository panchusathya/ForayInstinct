import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { db } from "@/db";
import * as schema from "../db/schema";
import { emptyCandidateProfile } from "@/lib/candidate-profile";
import {
  mapProfileToFormFields,
  type VisibleFormField,
} from "@/lib/application-runner/form-map";
import { alreadyInProgressStatus } from "@/lib/task-completion";
import { clickSubmitCode } from "@/lib/application-runner/playwright-scripts";

const databases: PGlite[] = [];

afterEach(async () => {
  vi.doUnmock("@/db");
  vi.doUnmock("@/lib/application-runner/run");
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
    const startApplication = await setupStart();
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

  const [scope, runner] = await Promise.all([
    import("@/db/services/scope"),
    import("@/lib/application-runner/start"),
  ]);
  await scope.ensureScope({ userId: "alice", workspaceId: "workspace:alice" });
  return runner.startApplication;
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
