CREATE TABLE "application_leases" (
  "execution_id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "created_by_user_id" text NOT NULL,
  "apply_url" text NOT NULL,
  "root_session_id" text NOT NULL,
  "worker_session_id" text,
  "status" text DEFAULT 'held' NOT NULL,
  "claimed_at" text NOT NULL,
  "expires_at" text NOT NULL,
  CONSTRAINT "application_leases_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "workspace_memberships"("workspace_id","user_id") ON DELETE cascade,
  CONSTRAINT "application_leases_status_check" CHECK ("status" IN ('held', 'released'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "application_leases_held_workspace_apply_url_idx" ON "application_leases" USING btree ("workspace_id","apply_url") WHERE "status" = 'held' AND "apply_url" <> '';
--> statement-breakpoint
CREATE INDEX "application_leases_held_expires_idx" ON "application_leases" USING btree ("status","expires_at");
--> statement-breakpoint
ALTER TABLE "browser_run_checkpoints" ADD COLUMN IF NOT EXISTS "execution_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_run_checkpoints_execution_created_idx" ON "browser_run_checkpoints" USING btree ("execution_id","created_at" DESC NULLS FIRST);
