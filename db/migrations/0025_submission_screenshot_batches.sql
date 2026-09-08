-- A review is several screenshots of one form, and they were written one row
-- at a time while a per-minute sweep and the inbound webhook claimed whatever
-- was pending. A claim that landed between two writes delivered one page of
-- five captioned as the whole review, and the candidate was asked to approve
-- a form they had seen a fifth of. Every capture now names the batch it was
-- written with, the batch is written in one statement, and a claim takes a
-- whole batch or nothing. Rows written before this each become their own
-- batch, so they still deliver.
ALTER TABLE "application_submission_screenshots"
	ADD COLUMN IF NOT EXISTS "batch_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE "application_submission_screenshots"
	SET "batch_id" = "session_id" || ':' || "created_at" || ':' || "id"::text
	WHERE "batch_id" = '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_submission_screenshots_batch_idx"
	ON "application_submission_screenshots" ("workspace_id", "batch_id", "delivered_at");
