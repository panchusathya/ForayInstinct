CREATE TABLE IF NOT EXISTS "goforay_sync_outbox" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS "goforay_sync_outbox_pending_idx"
  ON "goforay_sync_outbox" USING btree ("sent_at", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goforay_presented_postings" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "posting_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goforay_presented_postings_user_idx"
  ON "goforay_presented_postings" USING btree ("user_id", "created_at");
