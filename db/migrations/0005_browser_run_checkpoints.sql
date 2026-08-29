CREATE TABLE IF NOT EXISTS "browser_run_checkpoints" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "created_by_user_id" text NOT NULL,
  "created_at" text NOT NULL,
  "phase" text NOT NULL,
  "state" text,
  "action" text,
  "attempt" integer DEFAULT 0 NOT NULL,
  "page" text,
  "error_code" text,
  "actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "trace" jsonb DEFAULT '[]'::jsonb NOT NULL,
  CONSTRAINT "browser_run_checkpoints_membership_fkey"
    FOREIGN KEY ("workspace_id", "created_by_user_id")
    REFERENCES "public"."workspace_memberships"("workspace_id", "user_id")
    ON DELETE CASCADE ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_run_checkpoints_session_created_idx"
  ON "browser_run_checkpoints" USING btree ("session_id", "created_at" DESC NULLS FIRST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_run_checkpoints_workspace_created_idx"
  ON "browser_run_checkpoints" USING btree ("workspace_id", "created_at" DESC NULLS FIRST);
