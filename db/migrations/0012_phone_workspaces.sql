CREATE TABLE IF NOT EXISTS "goforay_workspace_links" (
  "workspace_id" text PRIMARY KEY NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL,
  "candidate_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goforay_workspace_links_org_candidate_uidx"
  ON "goforay_workspace_links" ("org_id", "candidate_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goforay_workspace_presented_postings" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "posting_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goforay_workspace_presented_postings_unique"
  ON "goforay_workspace_presented_postings" ("workspace_id", "posting_id");
