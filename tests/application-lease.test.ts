import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFile } from "node:fs/promises";
import type { db } from "@/db";
import * as schema from "../db/schema";

const databases: PGlite[] = [];

afterEach(async () => {
  vi.doUnmock("@/db");
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("application leases", () => {
  it("lets only one worker hold a posting and blocks a duplicate dispatch", async () => {
    const { claimApplicationLease, assertApplicationLeaseOwner } =
      await setup();
    const tracing = await import("@/lib/application-execution");
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const applyUrl = "https://jobs.example/step/1";
    const first = tracing.executionId("root-1", "call-1");
    const second = tracing.executionId("root-1", "call-2");

    const [winner, loser] = await Promise.all([
      claimApplicationLease({
        applyUrl,
        executionId: first,
        rootSessionId: "root-1",
        scope: alice,
      }),
      claimApplicationLease({
        applyUrl,
        executionId: second,
        rootSessionId: "root-1",
        scope: alice,
      }),
    ]);
    const acquired = [winner, loser].filter(
      (claim) => claim.status === "acquired"
    );
    const blocked = [winner, loser].filter(
      (claim) => claim.status === "already_in_progress"
    );
    expect(acquired).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      applyUrl,
      status: "already_in_progress",
    });

    await expect(
      assertApplicationLeaseOwner({
        parentCallId: acquired[0]?.executionId === first ? "call-1" : "call-2",
        rootSessionId: "root-1",
        workerSessionId: "worker-1",
      })
    ).resolves.toBeUndefined();
    await expect(
      assertApplicationLeaseOwner({
        parentCallId: acquired[0]?.executionId === first ? "call-2" : "call-1",
        rootSessionId: "root-1",
        workerSessionId: "worker-2",
      })
    ).rejects.toThrow(/already_in_progress/);
  });

  it("refuses a missing apply URL and a missing lease", async () => {
    const { claimApplicationLease, assertApplicationLeaseOwner } =
      await setup();
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    await expect(
      claimApplicationLease({
        applyUrl: "",
        executionId: "exec-empty",
        rootSessionId: "root-1",
        scope: alice,
      })
    ).rejects.toThrow("requires a posting apply_url");
    await expect(
      assertApplicationLeaseOwner({
        parentCallId: "never-claimed",
        rootSessionId: "root-1",
        workerSessionId: "worker-ghost",
      })
    ).rejects.toThrow("requires an application lease");
  });

  it("scopes traces and checkpoints to one posting", async () => {
    const leases = await setup();
    const checkpoints = await import("@/db/services/browser-run-checkpoints");
    const executions = await import("@/db/services/application-executions");
    const tracing = await import("@/lib/application-execution");
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const other = tracing.parseApplicationIdentity(
      "Application trace identity: role=Other; company=Other; apply_url=https://jobs.example/other/2"
    );
    await executions.createApplicationExecution({
      callId: "call-other",
      identity: other,
      model: "test-model",
      rootSessionId: "root-1",
      scope: alice,
    });
    await leases.claimApplicationLease({
      applyUrl: "https://jobs.example/step/1",
      executionId: tracing.executionId("root-1", "call-1"),
      rootSessionId: "root-1",
      scope: alice,
    });
    await executions.attachApplicationWorker({
      callId: "call-1",
      rootSessionId: "root-1",
      workerSessionId: "worker-1",
    });
    await executions.attachBrowserToApplicationExecution(
      alice,
      "browser-step",
      "worker-1"
    );
    await checkpoints.recordBrowserRunCheckpoint(alice, "browser-step", {
      phase: "computer",
      state: "completed",
    });
    await checkpoints.recordBrowserRunCheckpoint(alice, "browser-other", {
      phase: "computer",
      state: "completed",
    });

    const stepTraces = await executions.listApplicationExecutionTraces(alice, {
      applyUrl: "https://jobs.example/step/1",
    });
    expect(stepTraces.map((row) => row.applyUrl)).toEqual([
      "https://jobs.example/step/1",
      "https://jobs.example/step/1",
    ]);
    expect(
      await checkpoints.listBrowserRunCheckpointsForExecution(alice, {
        applyUrl: "https://jobs.example/step/1",
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "browser-step" }),
      ])
    );
    expect(
      (
        await checkpoints.listBrowserRunCheckpointsForExecution(alice, {
          applyUrl: "https://jobs.example/step/1",
        })
      ).some((row) => row.sessionId === "browser-other")
    ).toBe(false);
    expect(
      await executions.listApplicationExecutionTraces(alice, {})
    ).toEqual([]);
  });

  it("stops an overdue worker from taking another browser action", async () => {
    const { claimApplicationLease, assertApplicationLeaseOwner } =
      await setup();
    const tracing = await import("@/lib/application-execution");
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const applyUrl = "https://jobs.example/step/1";
    await claimApplicationLease({
      applyUrl,
      executionId: tracing.executionId("root-1", "call-1"),
      now: new Date(0),
      rootSessionId: "root-1",
      scope: alice,
    });
    await expect(
      assertApplicationLeaseOwner({
        now: new Date(tracing.APPLICATION_WORKER_ACTIVE_MS),
        parentCallId: "call-1",
        rootSessionId: "root-1",
        workerSessionId: "worker-1",
      })
    ).rejects.toThrow("20-minute safety limit");
  });

  it("lets the watchdog claim an expired lease", async () => {
    const { claimApplicationLease, claimOverdueApplicationLeases } =
      await setup();
    const tracing = await import("@/lib/application-execution");
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    await claimApplicationLease({
      applyUrl: "https://jobs.example/step/1",
      executionId: tracing.executionId("root-1", "call-1"),
      now: new Date(0),
      rootSessionId: "root-1",
      scope: alice,
    });
    const overdue = await claimOverdueApplicationLeases(
      new Date(tracing.APPLICATION_WORKER_ACTIVE_MS)
    );
    expect(overdue).toEqual([
      expect.objectContaining({
        executionId: tracing.executionId("root-1", "call-1"),
      }),
    ]);
  });
});

async function setup() {
  const client = new PGlite();
  databases.push(client);
  await applyMigration(client, "0000_fluffy_the_spike.sql");
  await applyMigration(client, "0005_browser_run_checkpoints.sql");
  await applyMigration(client, "0019_application_execution_traces.sql");
  await applyMigration(client, "0021_application_leases.sql");

  const pgliteDatabase = drizzle(client, { schema });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- adapter-compatible integration test double
  const database = pgliteDatabase as unknown as typeof db;
  vi.doMock("@/db", () => ({ ...schema, db: database }));

  const [scope, leases, executions, tracing] = await Promise.all([
    import("@/db/services/scope"),
    import("@/db/services/application-leases"),
    import("@/db/services/application-executions"),
    import("@/lib/application-execution"),
  ]);
  const alice = { userId: "alice", workspaceId: "workspace:alice" };
  await scope.ensureScope(alice);
  const identity = tracing.parseApplicationIdentity(
    "Application trace identity: role=Analyst; company=Step; apply_url=https://jobs.example/step/1"
  );
  await executions.createApplicationExecution({
    callId: "call-1",
    identity,
    model: "test-model",
    rootSessionId: "root-1",
    scope: alice,
  });
  await executions.createApplicationExecution({
    callId: "call-2",
    identity,
    model: "test-model",
    rootSessionId: "root-1",
    scope: alice,
  });
  return leases;
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
