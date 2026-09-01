-- The browser gateway provider persists each workspace's signed-in browser
-- storage state through the encrypted secret store under its own namespace.
ALTER TABLE "encrypted_secrets" DROP CONSTRAINT IF EXISTS "encrypted_secrets_namespace_check";--> statement-breakpoint
ALTER TABLE "encrypted_secrets" ADD CONSTRAINT "encrypted_secrets_namespace_check" CHECK ("namespace" IN ('vault', 'browser-state'));
