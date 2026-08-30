CREATE TABLE "candidate_resumes" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"media_type" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"characters" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_resumes" ADD CONSTRAINT "candidate_resumes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
