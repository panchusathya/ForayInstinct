-- One worker per posting: the duplicate-worker guard looks up unfinished
-- executions by workspace and normalized apply URL on every worker tool call.
CREATE INDEX IF NOT EXISTS "application_executions_workspace_apply_url_idx" ON "application_executions" USING btree ("workspace_id","apply_url","status");
