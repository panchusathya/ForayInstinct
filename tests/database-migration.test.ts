import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("database migrations", () => {
  it("creates a validated schema and keeps adoption migrations idempotent", async () => {
    const database = createDatabase();

    await applyMigration(database, "0000_fluffy_the_spike.sql");
    await applyMigration(database, "0001_better-auth.sql");
    await applyMigration(database, "0002_heavy_celestials.sql");
    await applyMigration(database, "0005_browser_run_checkpoints.sql");
    await applyMigration(database, "0000_fluffy_the_spike.sql");
    await applyMigration(database, "0001_better-auth.sql");
    await applyMigration(database, "0005_browser_run_checkpoints.sql");

    await database.exec(`
      INSERT INTO workspaces VALUES ('workspace-1', '2026-01-01');
      INSERT INTO vault_items VALUES (
        'contact-1',
        'workspace-1',
        'contact',
        'Checkout',
        '',
        '2026-01-01',
        '2026-01-01'
      );
    `);

    const tables = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'workspaces',
           'workspace_memberships',
           'vault_items',
           'settings',
           'agent_sessions',
           'browser_sessions',
           'browser_run_checkpoints',
           'chats',
           'encrypted_secrets',
           'user',
           'session',
           'account',
           'verification'
         )`
    );
    const pendingConstraints = await pendingConstraintCount(database);

    expect(tables.rows[0]?.count).toBe(13);
    expect(pendingConstraints).toBe(0);
    await expect(
      database.query("SELECT id FROM vault_items WHERE id = 'contact-1'")
    ).resolves.toMatchObject({ rows: [{ id: "contact-1" }] });
  }, 15_000);

  it("preserves legacy rows while enforcing constraints for new writes", async () => {
    const database = createDatabase();
    await database.exec(legacyRuntimeSchema);
    await database.exec(`
      INSERT INTO vault_items
      VALUES (
        'legacy-item',
        'orphan-workspace',
        'legacy-kind',
        'Legacy',
        '',
        '2026-01-01',
        '2026-01-01'
      );
      INSERT INTO chats (
        session_id,
        workspace_id,
        title,
        created_at,
        updated_at
      ) VALUES (
        'legacy-chat',
        'orphan-workspace',
        'Legacy',
        '2026-01-01',
        '2026-01-01'
      );
      `);

    await applyMigration(database, "0000_fluffy_the_spike.sql");
    await applyMigration(database, "0002_heavy_celestials.sql");

    const vault = await database.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM vault_items WHERE id = 'legacy-item'"
    );
    const chat = await database.query<{
      costUsd: number | null;
      inputTokens: number;
      outputTokens: number;
    }>(`SELECT
      cost_usd AS "costUsd",
      input_tokens AS "inputTokens",
      output_tokens AS "outputTokens"
    FROM chats
    WHERE session_id = 'legacy-chat'`);

    expect(vault.rows).toEqual([{ id: "legacy-item", kind: "legacy-kind" }]);
    expect(chat.rows).toEqual([
      { costUsd: null, inputTokens: 0, outputTokens: 0 },
    ]);
    expect(await pendingConstraintCount(database)).toBe(14);
    await expect(
      database.exec(`
        INSERT INTO vault_items
        VALUES (
          'new-invalid',
          'orphan-workspace',
          'legacy-kind',
          'Invalid',
          '',
          '2026-01-01',
          '2026-01-01'
        )
        `)
    ).rejects.toThrow(/constraint/);
  }, 15_000);

  it("stores the candidate's self-identification answers", async () => {
    // settings_key_check only admitted 'gateway_model', so saving an EEO
    // answer failed at the database and stalled the application on the
    // voluntary disclosures section it was meant to get past.
    const database = createDatabase();

    await applyMigration(database, "0000_fluffy_the_spike.sql");
    await applyMigration(database, "0008_self_identification_setting.sql");
    await applyMigration(database, "0008_self_identification_setting.sql");

    await database.exec(`
      INSERT INTO workspaces VALUES ('workspace-1', '2026-01-01');
      INSERT INTO settings VALUES (
        'workspace-1',
        'self_identification',
        '{"gender":"Male"}'
      );
      INSERT INTO settings VALUES ('workspace-1', 'gateway_model', 'openai/gpt-5');
    `);

    await expect(
      database.query<{ value: string }>(
        `SELECT value FROM settings WHERE key = 'self_identification'`
      )
    ).resolves.toMatchObject({ rows: [{ value: '{"gender":"Male"}' }] });
    expect(await pendingConstraintCount(database)).toBe(0);
    await expect(
      database.exec(
        `INSERT INTO settings VALUES ('workspace-1', 'unknown_key', 'x')`
      )
    ).rejects.toThrow(/constraint/);
  }, 15_000);

  it("stores an application-submitted screenshot until Linq delivers it", async () => {
    const database = createDatabase();

    await applyMigration(database, "0000_fluffy_the_spike.sql");
    await applyMigration(
      database,
      "0010_application_submission_screenshots.sql"
    );
    await applyMigration(
      database,
      "0010_application_submission_screenshots.sql"
    );

    await database.exec(`
      INSERT INTO workspaces VALUES ('workspace-1', '2026-01-01');
      INSERT INTO workspace_memberships VALUES (
        'workspace-1',
        'user-1',
        'owner',
        '2026-01-01'
      );
      INSERT INTO application_submission_screenshots (
        session_id,
        workspace_id,
        created_by_user_id,
        created_at,
        png_base64
      ) VALUES (
        'browser-1',
        'workspace-1',
        'user-1',
        '2026-01-01',
        'iVBORw0KGgo='
      );
    `);

    await expect(
      database.query<{ png_base64: string; delivered_at: string | null }>(
        `SELECT png_base64, delivered_at
         FROM application_submission_screenshots
         WHERE session_id = 'browser-1'`
      )
    ).resolves.toMatchObject({
      rows: [{ delivered_at: null, png_base64: "iVBORw0KGgo=" }],
    });
    expect(await pendingConstraintCount(database)).toBe(0);
  }, 15_000);

  it("stores the candidate ATS profile beside the workspace Kernel profile id", async () => {
    const database = createDatabase();

    await applyMigration(database, "0000_fluffy_the_spike.sql");
    await applyMigration(database, "0009_candidate_profile.sql");
    await applyMigration(database, "0009_candidate_profile.sql");

    await database.exec(`
      INSERT INTO workspaces (id, created_at) VALUES ('workspace-1', '2026-01-01');
      INSERT INTO candidate_profiles (workspace_id, legal_first_name, created_at, updated_at)
      VALUES ('workspace-1', 'Ada', '2026-01-01', '2026-01-01');
    `);

    await expect(
      database.query<{ legal_first_name: string; kernel_profile_id: string }>(
        `SELECT p.legal_first_name, w.kernel_profile_id
         FROM candidate_profiles p
         JOIN workspaces w ON w.id = p.workspace_id
         WHERE p.workspace_id = 'workspace-1'`
      )
    ).resolves.toMatchObject({
      rows: [{ legal_first_name: "Ada", kernel_profile_id: "" }],
    });
    await expect(
      database.exec(
        `INSERT INTO workspaces (id, created_at) VALUES ('workspace-2', '2026-01-01');
         INSERT INTO candidate_profiles (workspace_id, work_authorization, created_at, updated_at)
         VALUES ('workspace-2', 'not-a-status', '2026-01-01', '2026-01-01')`
      )
    ).rejects.toThrow(/constraint/);
  }, 15_000);

  it("stores workspace-owned candidate documents and remembered facts", async () => {
    const database = createDatabase();

    await applyMigration(database, "0000_fluffy_the_spike.sql");
    await applyMigration(database, "0011_candidate_documents.sql");
    await applyMigration(database, "0011_candidate_documents.sql");

    await database.exec(`
      INSERT INTO workspaces (id, created_at) VALUES ('workspace-1', '2026-01-01');
      INSERT INTO candidate_documents (
        id, workspace_id, kind, source, filename, mime_type, byte_size, sha256,
        is_default, extracted_text, bytes, created_at, updated_at
      ) VALUES (
        'doc-1',
        'workspace-1',
        'resume',
        'upload',
        'ada.pdf',
        'application/pdf',
        4,
        'abcd',
        'yes',
        'Ada Lovelace',
        '\\x25504446',
        '2026-01-01',
        '2026-01-01'
      );
      INSERT INTO workspace_memories VALUES (
        'workspace-1',
        'preferred_name',
        'Ada',
        '2026-01-01'
      );
    `);

    await expect(
      database.query<{ filename: string; key: string }>(
        `SELECT d.filename, m.key
         FROM candidate_documents d
         JOIN workspace_memories m ON m.workspace_id = d.workspace_id
         WHERE d.workspace_id = 'workspace-1'`
      )
    ).resolves.toMatchObject({
      rows: [{ filename: "ada.pdf", key: "preferred_name" }],
    });
    expect(await pendingConstraintCount(database)).toBe(0);
  }, 15_000);

  it("rejects a second default resume in the same workspace", async () => {
    const database = createDatabase();
    await applyMigration(database, "0000_fluffy_the_spike.sql");
    await applyMigration(database, "0011_candidate_documents.sql");
    await database.exec(`
      INSERT INTO workspaces (id, created_at) VALUES ('workspace-1', '2026-01-01');
      INSERT INTO candidate_documents (
        id, workspace_id, kind, source, filename, mime_type, byte_size, sha256,
        is_default, extracted_text, bytes, created_at, updated_at
      ) VALUES (
        'doc-1', 'workspace-1', 'resume', 'upload', 'one.pdf', 'application/pdf',
        4, 'one', 'yes', '', '\\x25504446', '2026-01-01', '2026-01-01'
      );
    `);
    await expect(
      database.exec(`
        INSERT INTO candidate_documents (
          id, workspace_id, kind, source, filename, mime_type, byte_size, sha256,
          is_default, extracted_text, bytes, created_at, updated_at
        ) VALUES (
          'doc-2', 'workspace-1', 'resume', 'upload', 'two.pdf', 'application/pdf',
          4, 'two', 'yes', '', '\\x25504446', '2026-01-01', '2026-01-01'
        )
      `)
    ).rejects.toThrow();
  }, 15_000);

  it("adopts existing Better Auth tables without changing their rows", async () => {
    const database = createDatabase();
    await database.exec(legacyAuthSchema);
    await database.exec(`
      INSERT INTO "user" (
        id,
        name,
        email,
        "emailVerified",
        "createdAt",
        "updatedAt"
      ) VALUES (
        'auth-user',
        'Auth User',
        'auth@example.com',
        false,
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );
      INSERT INTO "account" (
        id,
        issuer,
        "accountId",
        "providerId",
        "userId",
        "createdAt",
        "updatedAt"
      ) VALUES (
        'auth-account',
        'credential',
        'auth-user',
        'credential',
        'auth-user',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );
      INSERT INTO "session" (
        id,
        "expiresAt",
        token,
        "createdAt",
        "updatedAt",
        "userId"
      ) VALUES (
        'auth-session',
        '2027-01-01T00:00:00Z',
        'auth-token',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
        'auth-user'
      );
      INSERT INTO "verification" (
        id,
        identifier,
        value,
        "expiresAt",
        "createdAt",
        "updatedAt"
      ) VALUES (
        'auth-verification',
        '+12125550123',
        'hashed-code',
        '2027-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );
    `);

    await applyMigration(database, "0001_better-auth.sql");
    await applyMigration(database, "0001_better-auth.sql");
    await database.exec(`
      UPDATE "user"
      SET "phoneNumber" = '+12125550123', "phoneNumberVerified" = true
      WHERE id = 'auth-user'
    `);

    const rows = await database.query<{
      accountId: string;
      sessionId: string;
      userId: string;
      verificationId: string;
    }>(`
      SELECT
        "account".id AS "accountId",
        "session".id AS "sessionId",
        "user".id AS "userId",
        "verification".id AS "verificationId"
      FROM "user"
      JOIN "account" ON "account"."userId" = "user".id
      JOIN "session" ON "session"."userId" = "user".id
      JOIN "verification" ON "verification".identifier = "user"."phoneNumber"
    `);

    expect(rows.rows).toEqual([
      {
        accountId: "auth-account",
        sessionId: "auth-session",
        userId: "auth-user",
        verificationId: "auth-verification",
      },
    ]);
    await expect(
      database.exec(`
        INSERT INTO "session" (
          id,
          "expiresAt",
          token,
          "createdAt",
          "updatedAt",
          "userId"
        ) VALUES (
          'orphan-session',
          now(),
          'orphan-token',
          now(),
          now(),
          'missing-user'
        )
      `)
    ).rejects.toThrow(/foreign key constraint/);
  }, 15_000);

  it("carries already-shown roles into the source-agnostic presented table", async () => {
    const database = createDatabase();

    await applyMigration(database, "0000_fluffy_the_spike.sql");
    await applyMigration(database, "0012_phone_workspaces.sql");
    await database.exec(`
      INSERT INTO workspaces VALUES ('workspace-1', '2026-01-01');
      INSERT INTO goforay_workspace_presented_postings
        VALUES ('row-1', 'workspace-1', 'posting-9', '2026-01-01');
    `);

    await applyMigration(database, "0016_goforay_presented_roles.sql");
    // Re-applying must be safe: a deploy that runs migrations may be retried.
    await applyMigration(database, "0016_goforay_presented_roles.sql");

    const backfilled = await database.query<{
      posting_id: string;
      role_key: string;
    }>(
      `SELECT role_key, posting_id FROM goforay_workspace_presented_roles
       WHERE workspace_id = 'workspace-1'`
    );
    expect(backfilled.rows).toEqual([
      { posting_id: "posting-9", role_key: "posting:posting-9" },
    ]);

    // A public-market role has no posting id, which is the whole reason the
    // key is a string rather than a posting reference.
    await database.exec(`
      INSERT INTO goforay_workspace_presented_roles
        (workspace_id, role_key, url)
        VALUES ('workspace-1', 'url:jobs.example.co/analyst', 'jobs.example.co/analyst')
      ON CONFLICT DO NOTHING;
      INSERT INTO goforay_workspace_presented_roles
        (workspace_id, role_key, url)
        VALUES ('workspace-1', 'url:jobs.example.co/analyst', 'jobs.example.co/analyst')
      ON CONFLICT DO NOTHING;
    `);

    const rows = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM goforay_workspace_presented_roles
       WHERE workspace_id = 'workspace-1'`
    );
    expect(rows.rows[0]?.count).toBe(2);
  });
});

function createDatabase() {
  const database = new PGlite();
  databases.push(database);
  return database;
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

async function pendingConstraintCount(database: PGlite) {
  const result = await database.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM pg_constraint
     WHERE NOT convalidated
       AND connamespace = 'public'::regnamespace`
  );
  return result.rows[0]?.count;
}

const legacyRuntimeSchema = `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  CREATE TABLE workspace_memberships (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE TABLE vault_items (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    account TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (workspace_id, key)
  );
  CREATE TABLE agent_sessions (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE browser_sessions (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE chats (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE encrypted_secrets (
    workspace_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, namespace, id)
  );
`;

const legacyAuthSchema = `
  CREATE TABLE "user" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    "emailVerified" BOOLEAN DEFAULT false NOT NULL,
    image TEXT,
    "createdAt" TIMESTAMPTZ DEFAULT now() NOT NULL,
    "updatedAt" TIMESTAMPTZ DEFAULT now() NOT NULL
  );
  CREATE TABLE "account" (
    id TEXT PRIMARY KEY,
    issuer TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ,
    "refreshTokenExpiresAt" TIMESTAMPTZ,
    scope TEXT,
    password TEXT,
    "createdAt" TIMESTAMPTZ DEFAULT now() NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL
  );
  CREATE UNIQUE INDEX "account_issuer_accountId_uidx"
    ON "account" (issuer, "accountId");
  CREATE INDEX "account_userId_idx" ON "account" ("userId");
  CREATE TABLE "session" (
    id TEXT PRIMARY KEY,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    token TEXT NOT NULL UNIQUE,
    "createdAt" TIMESTAMPTZ DEFAULT now() NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
  );
  CREATE INDEX "session_userId_idx" ON "session" ("userId");
  CREATE TABLE "verification" (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT now() NOT NULL,
    "updatedAt" TIMESTAMPTZ DEFAULT now() NOT NULL
  );
  CREATE INDEX "verification_identifier_idx"
    ON "verification" (identifier);
`;
