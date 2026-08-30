CREATE TABLE IF NOT EXISTS "goforay_pending_role_searches" (
  "workspace_id" text PRIMARY KEY NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "thread_id" text NOT NULL,
  "query" text DEFAULT '' NOT NULL,
  "location" text DEFAULT '' NOT NULL,
  "pending" text DEFAULT '' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
