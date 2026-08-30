CREATE TABLE IF NOT EXISTS "application_submission_screenshots" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "created_by_user_id" text NOT NULL,
  "created_at" text NOT NULL,
  "page" text,
  "mime_type" text DEFAULT 'image/png' NOT NULL,
  "png_base64" text NOT NULL,
  "delivered_at" text,
  CONSTRAINT "application_submission_screenshots_membership_fkey"
    FOREIGN KEY ("workspace_id", "created_by_user_id")
    REFERENCES "public"."workspace_memberships"("workspace_id", "user_id")
    ON DELETE CASCADE ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_submission_screenshots_workspace_pending_idx"
  ON "application_submission_screenshots" USING btree (
    "workspace_id",
    "delivered_at",
    "created_at" DESC NULLS FIRST
  );
