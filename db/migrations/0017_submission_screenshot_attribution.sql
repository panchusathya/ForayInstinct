-- The review gate could not name the application it was asking about. A
-- screenshot row recorded only its browser session, so the delivering channel
-- captioned every batch "Before I submit — page N of M". With two applications
-- in flight the candidate saw one numbered run spanning two different jobs and
-- a single "yes" was ambiguous, which is exactly what the coordinator
-- instructions forbid ("name each by role and posting URL").
--
-- The worker already has both values -- request_submission_approval takes them
-- and records them on the checkpoint trail -- so this only persists them beside
-- the image that needs them.
--
-- Purely additive, and no backfill is possible: rows written before this
-- deploy never carried a role. They keep the empty default, and the channel
-- falls back to the unattributed caption for them.
ALTER TABLE "application_submission_screenshots"
	ADD COLUMN IF NOT EXISTS "role" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "application_submission_screenshots"
	ADD COLUMN IF NOT EXISTS "apply_url" text DEFAULT '' NOT NULL;
