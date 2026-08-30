import { z } from "zod";

export const databaseUrlSchema = z
  .string()
  .min(1, "Required")
  .refine(
    (value) =>
      value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "Must be a postgres:// or postgresql:// URL"
  );

export function toDirectPostgresUrl(url: string) {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace(/-pooler(?=\.)/u, "");
  return parsed.toString();
}

export function resolveDatabaseMigrationUrl(
  unpooled: string | undefined,
  pooled: string | undefined
) {
  const url = unpooled ?? pooled;
  if (url === undefined) {
    throw new Error(
      "Invalid environment variables: DATABASE_URL_UNPOOLED or DATABASE_URL is required for migrations"
    );
  }
  return toDirectPostgresUrl(url);
}
