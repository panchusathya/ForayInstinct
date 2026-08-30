-- The candidate's voluntary self-identification answers are stored in the
-- keyed settings table, but settings_key_check only ever admitted
-- 'gateway_model'. Saving an answer therefore failed at the database and
-- stopped the application on the EEO section it was meant to get past.
DO $$
DECLARE
	was_validated boolean;
BEGIN
	SELECT convalidated
	INTO was_validated
	FROM pg_constraint
	WHERE conrelid = 'public.settings'::regclass
		AND conname = 'settings_key_check';

	ALTER TABLE "settings" DROP CONSTRAINT IF EXISTS "settings_key_check";
	ALTER TABLE "settings" ADD CONSTRAINT "settings_key_check" CHECK ("settings"."key" IN ('gateway_model', 'self_identification')) NOT VALID;

	IF was_validated THEN
		ALTER TABLE "settings" VALIDATE CONSTRAINT "settings_key_check";
	END IF;
END
$$;
