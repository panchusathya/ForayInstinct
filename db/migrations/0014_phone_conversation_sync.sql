ALTER TABLE "goforay_pending_role_searches"
  ADD COLUMN IF NOT EXISTS "phone" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goforay_workspace_conversations" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "candidate_id" text,
  "channel" text NOT NULL,
  "url" text DEFAULT '' NOT NULL,
  "messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goforay_workspace_conversations_candidate_idx"
  ON "goforay_workspace_conversations" ("candidate_id", "updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goforay_workspace_sync_outbox" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "candidate_id" text,
  "conversation_id" text NOT NULL,
  "channel" text NOT NULL,
  "direction" text NOT NULL,
  "body" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text DEFAULT '' NOT NULL,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goforay_workspace_sync_outbox_pending_idx"
  ON "goforay_workspace_sync_outbox" ("sent_at", "created_at");
