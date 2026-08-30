import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { db } from "@/db";
import * as schema from "../db/schema";

const databases: PGlite[] = [];

afterEach(async () => {
  vi.doUnmock("@/db");
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("database services", () => {
  it("preserves workspace ownership across application domains", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyInitialMigration(client);

    const pgliteDatabase = drizzle(client, { schema });
    // PGlite exposes the PostgreSQL query builders and transaction behavior
    // used by the production node-postgres adapter.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- adapter-compatible integration test double
    const database = pgliteDatabase as unknown as typeof db;
    vi.doMock("@/db", () => ({ ...schema, db: database }));

    const [browsers, chats, secrets, sessions, settings, scope, vault] =
      await Promise.all([
        import("@/db/services/browsers"),
        import("@/db/services/chats"),
        import("@/db/services/secrets"),
        import("@/db/services/sessions"),
        import("@/db/services/settings"),
        import("@/db/services/scope"),
        import("@/db/services/vault"),
      ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const bob = { userId: "bob", workspaceId: "workspace:bob" };

    await scope.ensureScope(alice);
    await scope.ensureScope(bob);
    await sessions.claimSession(alice, "session-alice");

    expect(await sessions.isSessionOwned(alice, "session-alice")).toBe(true);
    expect(await sessions.isSessionOwned(bob, "session-alice")).toBe(false);
    expect(await sessions.listOwnedSessionIds(alice)).toEqual(
      new Set(["session-alice"])
    );
    expect(await sessions.listOwnedSessionIds(bob)).toEqual(new Set());

    await sessions.claimSession(alice, "session-imessage");
    const unindexedChats = (await chats.listChats(alice)).sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId)
    );
    expect(
      unindexedChats.map(({ sessionId, title, usage }) => ({
        sessionId,
        title,
        usage,
      }))
    ).toEqual([
      {
        sessionId: "session-alice",
        title: "New chat",
        usage: { costUsd: null, inputTokens: 0, outputTokens: 0 },
      },
      {
        sessionId: "session-imessage",
        title: "New chat",
        usage: { costUsd: null, inputTokens: 0, outputTokens: 0 },
      },
    ]);
    expect(
      unindexedChats.every(
        (chat) => chat.createdAt.length > 0 && chat.updatedAt.length > 0
      )
    ).toBe(true);

    await sessions.claimSession(bob, "session-alice");
    expect(await sessions.isSessionOwned(alice, "session-alice")).toBe(true);
    expect(await sessions.isSessionOwned(bob, "session-alice")).toBe(false);

    await chats.saveChat(alice, {
      sessionId: "session-alice",
      title: "Initial title",
      usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 4 },
    });
    await chats.saveChat(alice, {
      sessionId: "session-alice",
      title: "Updated title",
    });

    const aliceChat = await chats.readChat(alice, "session-alice");
    expect(aliceChat?.title).toBe("Updated title");
    expect(aliceChat?.usage).toEqual({
      costUsd: 0.25,
      inputTokens: 10,
      outputTokens: 4,
    });
    expect(await chats.readChat(bob, "session-alice")).toBeUndefined();
    const indexedChats = await chats.listChats(alice);
    expect(indexedChats).toHaveLength(2);
    expect(
      indexedChats.find((chat) => chat.sessionId === "session-alice")
    ).toEqual(aliceChat);
    expect(indexedChats.map((chat) => chat.sessionId)).toContain(
      "session-imessage"
    );
    expect(await chats.listChats(bob)).toEqual([]);

    await expect(
      chats.saveChat(bob, {
        sessionId: "session-alice",
        title: "Bob's title",
      })
    ).rejects.toThrow(/Failed query: insert into "chats"/);
    expect(await chats.readChat(alice, "session-alice")).toEqual(aliceChat);
    expect(await chats.readChat(bob, "session-alice")).toBeUndefined();

    await browsers.createBrowserSession(alice, {
      createdAt: new Date().toISOString(),
      sessionId: "browser-alice",
    });
    expect(
      await browsers.readBrowserSession(alice, "browser-alice")
    ).toBeDefined();
    expect(
      await browsers.readBrowserSession(bob, "browser-alice")
    ).toBeUndefined();
    expect(await browsers.listBrowserSessions(alice)).toHaveLength(1);
    expect(await browsers.deleteBrowserSession(bob, "browser-alice")).toBe(
      false
    );

    const now = new Date().toISOString();
    await vault.createVaultItem(alice, {
      account: "alice@example.com",
      createdAt: now,
      id: "vault-alice",
      kind: "login",
      label: "Alice",
      updatedAt: now,
    });
    expect(await vault.readVaultItem(alice, "vault-alice")).toMatchObject({
      id: "vault-alice",
    });
    expect(await vault.readVaultItem(bob, "vault-alice")).toBeUndefined();
    expect(await vault.listVaultItems(alice)).toHaveLength(1);
    expect(await vault.deleteVaultItem(bob, "vault-alice")).toBe(false);

    await secrets.writeEncryptedSecret(alice, "shared-id", "ciphertext-alice");
    await secrets.writeEncryptedSecret(bob, "shared-id", "ciphertext-bob");
    expect(await secrets.readEncryptedSecret(alice, "shared-id")).toBe(
      "ciphertext-alice"
    );
    expect(await secrets.readEncryptedSecret(bob, "shared-id")).toBe(
      "ciphertext-bob"
    );
    await secrets.deleteEncryptedSecret(alice, "shared-id");
    expect(
      await secrets.readEncryptedSecret(alice, "shared-id")
    ).toBeUndefined();
    expect(await secrets.readEncryptedSecret(bob, "shared-id")).toBe(
      "ciphertext-bob"
    );

    await settings.selectGatewayModel(alice, "openai/test");
    expect(await settings.readGatewayModel(alice)).toBe("openai/test");
    expect(await settings.readGatewayModel(bob)).toBeUndefined();
  }, 15_000);

  it("keeps an application alive when the answers cannot be stored", async () => {
    // A settings_key_check that admitted only 'gateway_model' turned this
    // write into a thrown tool error, which killed the application waiting on
    // the answer. Storing is a convenience; the answer itself is the result.
    const client = new PGlite();
    databases.push(client);
    await applyInitialMigration(client);

    const pgliteDatabase = drizzle(client, { schema });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- adapter-compatible integration test double
    const database = pgliteDatabase as unknown as typeof db;
    vi.doMock("@/db", () => ({ ...schema, db: database }));

    const [scope, selfIdentification] = await Promise.all([
      import("@/db/services/scope"),
      import("@/db/services/self-identification"),
    ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    await scope.ensureScope(alice);

    const rejected = await selfIdentification.saveSelfIdentification(alice, {
      gender: "Male",
    });

    expect(rejected).toEqual({ answers: { gender: "Male" }, stored: false });

    await applyMigration(client, "0008_self_identification_setting.sql");
    const accepted = await selfIdentification.saveSelfIdentification(alice, {
      disabilityStatus: "I do not wish to answer",
    });

    // The rejected answer was never stored, so it is absent from the merge
    // the widened constraint now accepts.
    expect(accepted).toEqual({
      answers: { disabilityStatus: "I do not wish to answer" },
      stored: true,
    });
    expect(await selfIdentification.readSelfIdentification(alice)).toEqual({
      disabilityStatus: "I do not wish to answer",
    });
  }, 15_000);

  it("keeps an application alive when the candidate profile cannot be stored", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyInitialMigration(client);

    const pgliteDatabase = drizzle(client, { schema });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- adapter-compatible integration test double
    const database = pgliteDatabase as unknown as typeof db;
    vi.doMock("@/db", () => ({ ...schema, db: database }));

    const [scope, candidateProfile, workspaces] = await Promise.all([
      import("@/db/services/scope"),
      import("@/db/services/candidate-profile"),
      import("@/db/services/workspaces"),
    ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const orphan = { userId: "alice", workspaceId: "workspace:missing" };

    const rejected = await candidateProfile.saveCandidateProfile(orphan, {
      legalFirstName: "Ada",
    });
    expect(rejected.stored).toBe(false);
    expect(rejected.profile.legalFirstName).toBe("Ada");

    const kernelRejected = await workspaces.saveWorkspaceKernelProfileId(
      orphan,
      "profile-1"
    );
    expect(kernelRejected).toEqual({ stored: false });

    await scope.ensureScope(alice);
    const accepted = await candidateProfile.saveCandidateProfile(alice, {
      legalFirstName: "Ada",
      legalLastName: "Lovelace",
    });
    expect(accepted.stored).toBe(true);
    expect(accepted.profile.legalFirstName).toBe("Ada");
    expect(accepted.profile.legalLastName).toBe("Lovelace");
    expect(await candidateProfile.readCandidateProfile(alice)).toEqual(
      accepted.profile
    );
    expect(
      await workspaces.saveWorkspaceKernelProfileId(alice, "profile-1")
    ).toEqual({ stored: true });
    expect(await workspaces.readWorkspaceKernelProfileId(alice)).toBe(
      "profile-1"
    );
  }, 15_000);

  it("hands the latest undelivered confirmation screenshot to the next consumer", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyInitialMigration(client);
    await applyMigration(client, "0010_application_submission_screenshots.sql");

    const pgliteDatabase = drizzle(client, { schema });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- adapter-compatible integration test double
    const database = pgliteDatabase as unknown as typeof db;
    vi.doMock("@/db", () => ({ ...schema, db: database }));

    const [scope, screenshots] = await Promise.all([
      import("@/db/services/scope"),
      import("@/db/services/application-submission-screenshots"),
    ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const bob = { userId: "bob", workspaceId: "workspace:bob" };
    await scope.ensureScope(alice);
    await scope.ensureScope(bob);

    await screenshots.saveApplicationSubmissionScreenshot(
      alice,
      "browser-old",
      { png: Buffer.from("older") }
    );
    await screenshots.saveApplicationSubmissionScreenshot(
      alice,
      "browser-new",
      { page: "https://example.com/confirmation", png: Buffer.from("newer") }
    );
    await screenshots.saveApplicationSubmissionScreenshot(bob, "browser-bob", {
      png: Buffer.from("other-workspace"),
    });

    await expect(
      screenshots.consumeLatestApplicationSubmissionScreenshot(alice)
    ).resolves.toEqual({
      mimeType: "image/png",
      png: Buffer.from("newer"),
    });
    await expect(
      screenshots.consumeLatestApplicationSubmissionScreenshot(alice)
    ).resolves.toEqual({
      mimeType: "image/png",
      png: Buffer.from("older"),
    });
    await expect(
      screenshots.consumeLatestApplicationSubmissionScreenshot(alice)
    ).resolves.toBeUndefined();
    await expect(
      screenshots.consumeLatestApplicationSubmissionScreenshot(bob)
    ).resolves.toEqual({
      mimeType: "image/png",
      png: Buffer.from("other-workspace"),
    });
  }, 15_000);

  it("keeps one resume per workspace and replaces it on re-upload", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyInitialMigration(client);
    await applyMigration(client, "0011_shocking_human_robot.sql");

    const pgliteDatabase = drizzle(client, { schema });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- adapter-compatible integration test double
    const database = pgliteDatabase as unknown as typeof db;
    vi.doMock("@/db", () => ({ ...schema, db: database }));

    const [scope, resumes] = await Promise.all([
      import("@/db/services/scope"),
      import("@/db/services/candidate-resume"),
    ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const bob = { userId: "bob", workspaceId: "workspace:bob" };
    const orphan = { userId: "alice", workspaceId: "workspace:missing" };
    await scope.ensureScope(alice);
    await scope.ensureScope(bob);

    await expect(resumes.readCandidateResume(alice)).resolves.toBeUndefined();

    await resumes.saveCandidateResume(alice, {
      filename: "first.pdf",
      mediaType: "application/pdf",
      text: "Analyst at Example Co",
    });
    await resumes.saveCandidateResume(alice, {
      filename: "second.pdf",
      mediaType: "application/pdf",
      text: "Senior analyst at Example Co",
    });

    // Re-uploading replaces rather than accumulating: there is one current
    // resume per candidate.
    await expect(resumes.readCandidateResume(alice)).resolves.toMatchObject({
      characters: "Senior analyst at Example Co".length,
      filename: "second.pdf",
      text: "Senior analyst at Example Co",
    });
    await expect(resumes.readCandidateResume(bob)).resolves.toBeUndefined();

    // A workspace that does not exist must not throw and end the upload.
    await expect(
      resumes.saveCandidateResume(orphan, {
        filename: "orphan.pdf",
        mediaType: "application/pdf",
        text: "nobody",
      })
    ).resolves.toEqual({ stored: false });
  }, 15_000);
});

async function applyMigration(database: PGlite, name: string) {
  const migration = await readFile(
    new URL(`../db/migrations/${name}`, import.meta.url),
    "utf8"
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}

async function applyInitialMigration(database: PGlite) {
  await applyMigration(database, "0000_fluffy_the_spike.sql");
  await applyMigration(database, "0009_candidate_profile.sql");
}
