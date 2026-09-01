CREATE TABLE "application_executions" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "created_by_user_id" text NOT NULL,
  "root_session_id" text NOT NULL,
  "parent_call_id" text NOT NULL,
  "worker_session_id" text,
  "browser_session_id" text,
  "role" text DEFAULT '' NOT NULL,
  "company" text DEFAULT '' NOT NULL,
  "apply_url" text DEFAULT '' NOT NULL,
  "model" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "active_turn_id" text,
  "active_started_at" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "finished_at" text,
  CONSTRAINT "application_executions_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "workspace_memberships"("workspace_id","user_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "application_executions_root_call_idx" ON "application_executions" USING btree ("root_session_id","parent_call_id");
--> statement-breakpoint
CREATE INDEX "application_executions_workspace_updated_idx" ON "application_executions" USING btree ("workspace_id","updated_at" DESC NULLS FIRST);
--> statement-breakpoint
CREATE INDEX "application_executions_active_idx" ON "application_executions" USING btree ("status","active_started_at");
--> statement-breakpoint
CREATE TABLE "application_execution_events" (
  "id" text PRIMARY KEY NOT NULL,
  "execution_id" text NOT NULL REFERENCES "application_executions"("id") ON DELETE cascade,
  "event_type" text NOT NULL,
  "stage" text NOT NULL,
  "tool_name" text,
  "status" text,
  "error_code" text,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "application_execution_events_execution_created_idx" ON "application_execution_events" USING btree ("execution_id","created_at" DESC NULLS FIRST);
