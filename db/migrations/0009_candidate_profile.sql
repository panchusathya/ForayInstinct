-- Candidate ATS profile (not EEO, not secrets) plus the workspace-scoped
-- Kernel browser profile id used to persist signed-in sessions.
ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "kernel_profile_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate_profiles" (
  "workspace_id" text PRIMARY KEY NOT NULL,
  "legal_first_name" text DEFAULT '' NOT NULL,
  "legal_last_name" text DEFAULT '' NOT NULL,
  "preferred_name" text DEFAULT '' NOT NULL,
  "location_city" text DEFAULT '' NOT NULL,
  "location_region" text DEFAULT '' NOT NULL,
  "location_postal_code" text DEFAULT '' NOT NULL,
  "location_country_code" text DEFAULT '' NOT NULL,
  "work_authorization" text DEFAULT '' NOT NULL,
  "requires_sponsorship_now" text DEFAULT '' NOT NULL,
  "requires_sponsorship_future" text DEFAULT '' NOT NULL,
  "salary_min" integer,
  "salary_max" integer,
  "salary_currency" text DEFAULT 'USD' NOT NULL,
  "salary_period" text DEFAULT '' NOT NULL,
  "earliest_start_date" text DEFAULT '' NOT NULL,
  "willing_to_relocate" text DEFAULT '' NOT NULL,
  "work_arrangement" text DEFAULT '' NOT NULL,
  "headline" text DEFAULT '' NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "years_experience" integer,
  "skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "links" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "work_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "education" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "candidate_profiles_workspace_id_fkey"
    FOREIGN KEY ("workspace_id")
    REFERENCES "public"."workspaces"("id")
    ON DELETE CASCADE ON UPDATE no action,
  CONSTRAINT "candidate_profiles_work_authorization_check"
    CHECK ("work_authorization" IN ('', 'us_citizen', 'us_permanent_resident', 'us_visa_no_sponsorship', 'requires_sponsorship', 'other')),
  CONSTRAINT "candidate_profiles_requires_sponsorship_now_check"
    CHECK ("requires_sponsorship_now" IN ('', 'yes', 'no')),
  CONSTRAINT "candidate_profiles_requires_sponsorship_future_check"
    CHECK ("requires_sponsorship_future" IN ('', 'yes', 'no')),
  CONSTRAINT "candidate_profiles_salary_period_check"
    CHECK ("salary_period" IN ('', 'year', 'hour')),
  CONSTRAINT "candidate_profiles_willing_to_relocate_check"
    CHECK ("willing_to_relocate" IN ('', 'yes', 'no')),
  CONSTRAINT "candidate_profiles_work_arrangement_check"
    CHECK ("work_arrangement" IN ('', 'remote', 'hybrid', 'onsite', 'flexible'))
);
