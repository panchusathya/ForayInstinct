-- Two more personal values join the encrypted per-workspace store: the
-- candidate's own phone number (`contact`), which an iMessage-only candidate
-- otherwise has nowhere, and one application run's answers by question
-- (`application-answers`), so a form filled again in a fresh browser after
-- the last one died does not ask them over.
ALTER TABLE "encrypted_secrets" DROP CONSTRAINT IF EXISTS "encrypted_secrets_namespace_check";--> statement-breakpoint
ALTER TABLE "encrypted_secrets" ADD CONSTRAINT "encrypted_secrets_namespace_check" CHECK ("namespace" IN ('vault', 'browser-state', 'contact', 'application-answers'));
