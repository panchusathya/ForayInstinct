import { defineConfig } from "drizzle-kit";
import { databaseMigrationUrl } from "./env/migration";

export default defineConfig({
  dbCredentials: { url: databaseMigrationUrl },
  dialect: "postgresql",
  out: "./db/migrations",
  schema: "./db/schema/index.ts",
});
