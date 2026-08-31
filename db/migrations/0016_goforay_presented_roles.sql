-- Follow-on role batches were repeating roles a candidate had already seen.
-- The existing table can only key on a JuiceBox posting id, and public-market
-- roles have none, so they were never recorded and could never be excluded.
-- This table keys on a source-agnostic role key instead: `posting:<id>` when
-- the CRM supplies one, `url:<normalized apply url>` otherwise.
--
-- Purely additive. The previously deployed app keeps writing the old table
-- during a rollout, and those writes are simply ignored; both legacy tables
-- come out in a later migration.
CREATE TABLE IF NOT EXISTS "goforay_workspace_presented_roles" (
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"role_key" text NOT NULL,
	"posting_id" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goforay_workspace_presented_roles_pkey" PRIMARY KEY ("workspace_id", "role_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goforay_workspace_presented_roles_recent_idx"
	ON "goforay_workspace_presented_roles" ("workspace_id", "created_at");
--> statement-breakpoint
-- Carry over what the candidate has already been shown, so the first search
-- after this deploys does not re-serve a batch the old table already recorded.
INSERT INTO "goforay_workspace_presented_roles"
	("workspace_id", "role_key", "posting_id", "created_at")
SELECT "workspace_id", 'posting:' || "posting_id", "posting_id", "created_at"
FROM "goforay_workspace_presented_postings"
ON CONFLICT DO NOTHING;
