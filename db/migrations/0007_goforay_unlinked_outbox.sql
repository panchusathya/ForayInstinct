-- A locally captured message must survive even while its first JuiceBox
-- identity link is unavailable. The retrying bridge later resolves the CRM
-- candidate from the verified service-token identities.
ALTER TABLE "goforay_conversations" ALTER COLUMN "candidate_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "goforay_sync_outbox" ALTER COLUMN "candidate_id" DROP NOT NULL;
