-- Screenshots used to be captured only after an ATS confirmed a submission, so
-- every stored row was proof that an application had already gone out. The
-- pre-submission review gate stores a second kind: the completed form as the
-- candidate is asked to check it, before anything is submitted. The delivering
-- channel needs to tell the two apart to caption them correctly, and existing
-- rows are all proofs, which is what the default records.
ALTER TABLE "application_submission_screenshots"
  ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'submitted' NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
	was_validated boolean;
BEGIN
	SELECT convalidated
	INTO was_validated
	FROM pg_constraint
	WHERE conrelid = 'public.application_submission_screenshots'::regclass
		AND conname = 'application_submission_screenshots_kind_check';

	ALTER TABLE "application_submission_screenshots" DROP CONSTRAINT IF EXISTS "application_submission_screenshots_kind_check";
	ALTER TABLE "application_submission_screenshots" ADD CONSTRAINT "application_submission_screenshots_kind_check" CHECK ("application_submission_screenshots"."kind" IN ('review', 'submitted')) NOT VALID;

	IF was_validated IS NOT FALSE THEN
		ALTER TABLE "application_submission_screenshots" VALIDATE CONSTRAINT "application_submission_screenshots_kind_check";
	END IF;
END
$$;
