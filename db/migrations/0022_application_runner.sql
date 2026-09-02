ALTER TABLE IF EXISTS "application_executions" ADD COLUMN IF NOT EXISTS "workflow_run_id" text;
--> statement-breakpoint
ALTER TABLE IF EXISTS "application_executions" ADD COLUMN IF NOT EXISTS "pause_reason" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_executions_workflow_run_idx" ON "application_executions" USING btree ("workflow_run_id");
