import { loadEnvConfig } from "@next/env";
import { createEnv } from "@t3-oss/env-nextjs";
import { databaseUrlSchema, resolveDatabaseMigrationUrl } from "./utils";

loadEnvConfig(process.cwd());

const dbMigrationEnv = createEnv({
  server: {
    DATABASE_URL: databaseUrlSchema.optional(),
    DATABASE_URL_UNPOOLED: databaseUrlSchema.optional(),
  },
  emptyStringAsUndefined: true,
  experimental__runtimeEnv: {},
});

export const databaseMigrationUrl = resolveDatabaseMigrationUrl(
  dbMigrationEnv.DATABASE_URL_UNPOOLED,
  dbMigrationEnv.DATABASE_URL
);
