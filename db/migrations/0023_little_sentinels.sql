-- The address a candidate puts on applications, distinct from the Better Auth
-- login identity. A candidate who only ever texts has no verified email there,
-- so an ATS Email field had nothing to draw on and was asked for every time.
ALTER TABLE "candidate_profiles"
  ADD COLUMN IF NOT EXISTS "contact_email" text DEFAULT '' NOT NULL;
