-- The CRM mirror signed its requests with the workspace id where a user id
-- was required, which happened to work for phone-keyed workspaces (the two
-- are equal there) and failed forever for every other one. The outbox row
-- now records who wrote it. Retries are also spaced out: a row that can
-- never send used to be retried every five minutes ahead of everything
-- behind it. The background role search records the owning user the same
-- way, so the scope it runs under is a real user's.
ALTER TABLE "goforay_workspace_sync_outbox"
	ADD COLUMN IF NOT EXISTS "created_by_user_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "goforay_workspace_sync_outbox"
	ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "goforay_pending_role_searches"
	ADD COLUMN IF NOT EXISTS "user_id" text DEFAULT '' NOT NULL;
