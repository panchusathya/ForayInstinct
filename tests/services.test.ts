import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
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

    await sessions.claimSession(alice, "session-retry");
    await Promise.all([
      chats.saveChat(alice, { sessionId: "session-retry" }),
      chats.saveChat(alice, { sessionId: "session-retry" }),
    ]);
    expect(await chats.readChat(alice, "session-retry")).toMatchObject({
      sessionId: "session-retry",
      title: "New chat",
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
    expect(indexedChats).toHaveLength(3);
    expect(
      indexedChats.find((chat) => chat.sessionId === "session-alice")
    ).toEqual(aliceChat);
    expect(indexedChats.map((chat) => chat.sessionId)).toContain(
      "session-imessage"
    );
    expect(indexedChats.map((chat) => chat.sessionId)).toContain(
      "session-retry"
    );
    expect(await chats.listChats(bob)).toEqual([]);

    await expect(
      chats.saveChat(bob, {
        sessionId: "session-alice",
        title: "Bob's title",
      })
    ).rejects.toThrow("Chat session belongs to another workspace.");
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

  it("stores a resume in the workspace and recalls it as the default", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyInitialMigration(client);
    await applyMigration(client, "0011_candidate_documents.sql");

    const pgliteDatabase = drizzle(client, { schema });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- adapter-compatible integration test double
    const database = pgliteDatabase as unknown as typeof db;
    vi.doMock("@/db", () => ({ ...schema, db: database }));

    const [scope, documents, memories, capture] = await Promise.all([
      import("@/db/services/scope"),
      import("@/db/services/candidate-documents"),
      import("@/db/services/workspace-memories"),
      import("@/db/services/workspace-memory-capture"),
    ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    await scope.ensureScope(alice);

    const saved = await documents.saveCandidateDocument(alice, {
      bytes: Buffer.from("%PDF-1.1\n(Ada Lovelace)\n"),
      filename: "Ada_Resume.pdf",
      kind: "resume",
      mimeType: "application/pdf",
      source: "upload",
    });
    expect(saved.created).toBe(true);
    expect(saved.document.isDefault).toBe(true);
    expect(saved.document.extractedText).toContain("Ada Lovelace");

    const listed = await documents.listCandidateDocuments(alice);
    expect(listed).toHaveLength(1);
    const defaultResume = await documents.readDefaultResume(alice);
    expect(defaultResume?.filename).toBe("Ada_Resume.pdf");
    expect(defaultResume?.bytes.equals(saved.document.bytes)).toBe(true);

    await memories.saveWorkspaceMemory(alice, "target_role", "Staff engineer");
    expect(
      await capture.observeWorkspaceConversation(
        alice,
        [
          {
            content:
              "My name is Ada Lovelace. I live in Austin, Texas and I can start ASAP.",
            role: "user",
          },
        ],
        "op-1"
      )
    ).toEqual({ captured: 3, replayed: false });
    expect(
      await capture.observeWorkspaceConversation(
        alice,
        [{ content: "I live in Boston", role: "user" }],
        "op-1"
      )
    ).toEqual({ captured: 0, replayed: true });
    expect(await memories.listWorkspaceMemories(alice)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "target_role",
          value: "Staff engineer",
        }),
        expect.objectContaining({
          key: "stated_name",
          value: "Ada Lovelace",
        }),
        expect.objectContaining({
          key: "location",
          value: "Austin, Texas",
        }),
        expect.objectContaining({
          key: "earliest_start",
          value: "immediately",
        }),
        expect.objectContaining({
          key: "capture.operation",
          value: "op-1",
        }),
      ])
    );
    expect(await memories.listWorkspaceMemories(alice)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "location", value: "Boston" }),
      ])
    );
  }, 15_000);

  it("stores a resume whose PDF text is UTF-16BE encoded", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyInitialMigration(client);
    await applyMigration(client, "0011_candidate_documents.sql");

    const pgliteDatabase = drizzle(client, { schema });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- adapter-compatible integration test double
    const database = pgliteDatabase as unknown as typeof db;
    vi.doMock("@/db", () => ({ ...schema, db: database }));

    const [scope, documents] = await Promise.all([
      import("@/db/services/scope"),
      import("@/db/services/candidate-documents"),
    ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    await scope.ensureScope(alice);

    // A UTF-16BE literal is one of the encodings a word processor emits once
    // the text leaves plain ASCII, and it puts a NUL byte before every ASCII
    // character. A Postgres text column rejects NUL, so an unsanitized
    // extraction fails the insert and loses the candidate's resume.
    const saved = await documents.saveCandidateDocument(alice, {
      bytes: utf16PdfFixture("Ada Lovelace — Staff Engineer • Austin"),
      filename: "Ada_Resume.pdf",
      kind: "resume",
      mimeType: "application/pdf",
      source: "linq",
    });

    expect(saved.created).toBe(true);
    expect(saved.document.extractedText).toContain("Ada Lovelace");
    expect(saved.document.extractedText).toContain("Staff Engineer");
    expect(saved.document.extractedText).not.toContain("\u0000");

    const stored = await documents.readDefaultResume(alice);
    expect(stored?.extractedText).toContain("Ada Lovelace");
  });

  it("claims one application's screenshots in page order, not the whole workspace", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyInitialMigration(client);
    await applyMigration(client, "0010_application_submission_screenshots.sql");
    await applyMigration(client, "0015_submission_review_screenshots.sql");
    await applyMigration(client, "0017_submission_screenshot_attribution.sql");

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
      "browser-review",
      {
        applyUrl: "https://example.com/apply",
        kind: "review",
        page: "https://example.com/apply",
        png: Buffer.from("review-top"),
        role: "Staff Engineer",
      }
    );
    await screenshots.saveApplicationSubmissionScreenshot(
      alice,
      "browser-review",
      {
        applyUrl: "https://example.com/apply",
        kind: "review",
        page: "https://example.com/apply",
        png: Buffer.from("review-bottom"),
        role: "Staff Engineer",
      }
    );
    await screenshots.saveApplicationSubmissionScreenshot(
      alice,
      "browser-other",
      {
        applyUrl: "https://other.example.com/apply",
        kind: "review",
        page: "https://other.example.com/apply",
        png: Buffer.from("second-application"),
        role: "Product Manager",
      }
    );
    await screenshots.saveApplicationSubmissionScreenshot(bob, "browser-bob", {
      kind: "submitted",
      png: Buffer.from("other-workspace"),
    });

    // The most recently captured application must arrive first. A scroll-
    // stitched review still arrives whole and top-first, and a second
    // application must NOT be numbered into the same run — one "yes" cannot
    // mean two different jobs.
    const first =
      await screenshots.claimPendingApplicationSubmissionScreenshots(alice);
    expect(
      first.map((row) => [row.role, row.png.toString(), row.sessionId])
    ).toEqual([["Product Manager", "second-application", "browser-other"]]);

    const second =
      await screenshots.claimPendingApplicationSubmissionScreenshots(alice);
    expect(
      second.map((row) => [row.role, row.png.toString(), row.sessionId])
    ).toEqual([
      ["Staff Engineer", "review-top", "browser-review"],
      ["Staff Engineer", "review-bottom", "browser-review"],
    ]);
    await expect(
      screenshots.claimPendingApplicationSubmissionScreenshots(alice)
    ).resolves.toEqual([]);

    const others =
      await screenshots.claimPendingApplicationSubmissionScreenshots(bob);
    expect(others.map((row) => row.png.toString())).toEqual([
      "other-workspace",
    ]);

    // Claiming stamps `deliveredAt` before anything is posted, so a failed
    // upload used to destroy the review while the candidate was still being
    // asked to reply yes. The ids have to go back on the queue.
    await screenshots.releaseApplicationSubmissionScreenshots(
      alice,
      first.map((row) => row.id)
    );
    const reoffered =
      await screenshots.claimPendingApplicationSubmissionScreenshots(alice);
    expect(reoffered.map((row) => row.png.toString())).toEqual([
      "second-application",
    ]);

    // Releasing is workspace-scoped: one workspace must not be able to put
    // another's rows back on the queue by id.
    await screenshots.releaseApplicationSubmissionScreenshots(
      bob,
      reoffered.map((row) => row.id)
    );
    await expect(
      screenshots.claimPendingApplicationSubmissionScreenshots(alice)
    ).resolves.toEqual([]);
  }, 20_000);

  it("excludes an already-shown role under either of its identities", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyInitialMigration(client);
    // 0016 backfills from the table 0012 creates.
    await applyMigration(client, "0012_phone_workspaces.sql");
    await applyMigration(client, "0016_goforay_presented_roles.sql");

    const pgliteDatabase = drizzle(client, { schema });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- adapter-compatible integration test double
    const database = pgliteDatabase as unknown as typeof db;
    vi.doMock("@/db", () => ({ ...schema, db: database }));

    const [scope, presented] = await Promise.all([
      import("@/db/services/scope"),
      import("@/db/services/goforay-presented-roles"),
    ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    await scope.ensureScope(alice);

    // Shown from the curated feed, which is the only source that has a posting
    // id. The row records the normalized URL too.
    await presented.rememberPresentedRoles(alice, [
      {
        company: "Acme",
        location: "Remote",
        posting_id: "posting-1",
        reasons: [],
        title: "Staff Engineer",
        url: "https://boards.greenhouse.io/acme/jobs/1?utm_source=email",
      },
    ]);

    // Public search finds the same posting and carries no posting id, so the
    // only identity it can be recognised by is the URL. Writing the url column
    // and never reading it is what let the role come back a second time.
    const { keys } = await presented.listPresentedRoles(alice);
    expect(keys).toContain("posting:posting-1");
    expect(keys).toContain("url:boards.greenhouse.io/acme/jobs/1");
  }, 15_000);

  it("rejects a screenshot kind the delivering channel cannot caption", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyInitialMigration(client);
    await applyMigration(client, "0010_application_submission_screenshots.sql");
    await applyMigration(client, "0015_submission_review_screenshots.sql");

    const pgliteDatabase = drizzle(client, { schema });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- adapter-compatible integration test double
    const database = pgliteDatabase as unknown as typeof db;
    vi.doMock("@/db", () => ({ ...schema, db: database }));

    const scope = await import("@/db/services/scope");
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    await scope.ensureScope(alice);

    const insert = (kind: string) =>
      client.query(
        `INSERT INTO application_submission_screenshots
          (session_id, workspace_id, created_by_user_id, created_at, kind, png_base64)
          VALUES ('browser', $1, $2, '2026-01-01T00:00:00.000Z', $3, 'cG5n')`,
        [alice.workspaceId, alice.userId, kind]
      );

    // Guards the migration itself: without the check the channel would silently
    // caption an unknown kind as submitted proof.
    await expect(insert("review")).resolves.toBeDefined();
    await expect(insert("guessed")).rejects.toThrow(
      /application_submission_screenshots_kind_check/
    );
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

/**
 * A single-page PDF whose only content stream is Flate-compressed and whose
 * text is a UTF-16BE literal, matching what a real word processor exports.
 */
function utf16PdfFixture(text: string) {
  const compressed = deflateSync(
    Buffer.from(`BT /F1 12 Tf ${pdfUtf16Literal(text)} Tj ET`, "latin1")
  );
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Length ${String(compressed.byteLength)} /Filter /FlateDecode >>\nstream\n`,
      "latin1"
    ),
    compressed,
    Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
  ]);
}

function pdfUtf16Literal(text: string) {
  const encoded = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from(text, "utf16le").swap16(),
  ]);
  let literal = "";
  for (const byte of encoded) {
    // A byte that happens to equal "(", ")" or "\\" must be escaped even inside
    // a two-byte encoding.
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) {
      literal += `\\${String.fromCharCode(byte)}`;
      continue;
    }
    literal += String.fromCharCode(byte);
  }
  return `(${literal})`;
}
