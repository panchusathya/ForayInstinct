-- Legacy-workspace adoption ran its whole transaction on every request and
-- never converged, because nothing recorded that a legacy workspace had been
-- absorbed. The marker below does; the row itself stays, since deleting it
-- cascades into application executions and leases that adoption never
-- re-homes. The phone scope an iMessage candidate is keyed by used to be
-- found by hashing every verified user's number on each lookup; the
-- generated column is that digest, computed once and indexed. Its expression
-- mirrors `accessScopeForPhone`: sha256 of the E.164 number, hex, first 32.
-- The last statement clears the sign-up placeholder that reached legal-name
-- fields as "Phone" "user".
ALTER TABLE "workspaces"
	ADD COLUMN IF NOT EXISTS "adopted_into_workspace_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "user"
	ADD COLUMN IF NOT EXISTS "phoneScope" text GENERATED ALWAYS AS (
		CASE
			WHEN "phoneNumberVerified" IS TRUE
				AND "phoneNumber" ~ '^\+[1-9][0-9]{6,14}$'
			THEN 'phone:' || left(encode(sha256(decode("phoneNumber", 'escape')), 'hex'), 32)
		END
	) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_phoneScope_idx" ON "user" USING btree ("phoneScope");
--> statement-breakpoint
UPDATE "candidate_profiles"
	SET "legal_first_name" = '', "legal_last_name" = ''
	WHERE "legal_first_name" = 'Phone' AND "legal_last_name" = 'user';
