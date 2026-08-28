CREATE TABLE IF NOT EXISTS "goforay_links" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL,
  "candidate_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goforay_links_org_candidate_uidx"
  ON "goforay_links" USING btree ("org_id", "candidate_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goforay_conversations" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "candidate_id" text NOT NULL,
  "channel" text NOT NULL,
  "url" text DEFAULT '' NOT NULL,
  "messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goforay_conversations_candidate_idx"
  ON "goforay_conversations" USING btree ("candidate_id", "updated_at");
