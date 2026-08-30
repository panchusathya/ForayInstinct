-- First-party candidate files and free-form workspace facts. Resume bytes
-- live here so applications do not depend on JuiceBox document storage.
CREATE TABLE IF NOT EXISTS "candidate_documents" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "kind" text NOT NULL,
  "source" text NOT NULL,
  "filename" text NOT NULL,
  "mime_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "sha256" text NOT NULL,
  "is_default" text DEFAULT '' NOT NULL,
  "extracted_text" text DEFAULT '' NOT NULL,
  "bytes" bytea NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "candidate_documents_workspace_id_fkey"
    FOREIGN KEY ("workspace_id")
    REFERENCES "public"."workspaces"("id")
    ON DELETE CASCADE ON UPDATE no action,
  CONSTRAINT "candidate_documents_kind_check"
    CHECK ("kind" IN ('resume', 'cover_letter', 'transcript', 'other')),
  CONSTRAINT "candidate_documents_source_check"
    CHECK ("source" IN ('upload', 'gmail', 'linq', 'goforay')),
  CONSTRAINT "candidate_documents_is_default_check"
    CHECK ("is_default" IN ('', 'yes')),
  CONSTRAINT "candidate_documents_byte_size_check"
    CHECK ("byte_size" > 0 AND "byte_size" <= 8388608)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "candidate_documents_workspace_default_resume_idx"
  ON "candidate_documents" ("workspace_id")
  WHERE "kind" = 'resume' AND "is_default" = 'yes';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candidate_documents_workspace_updated_idx"
  ON "candidate_documents" USING btree (
    "workspace_id",
    "updated_at" DESC NULLS FIRST
  );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_memories" (
  "workspace_id" text NOT NULL,
  "key" text NOT NULL,
  "value" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "workspace_memories_pkey"
    PRIMARY KEY ("workspace_id", "key"),
  CONSTRAINT "workspace_memories_workspace_id_fkey"
    FOREIGN KEY ("workspace_id")
    REFERENCES "public"."workspaces"("id")
    ON DELETE CASCADE ON UPDATE no action
);
