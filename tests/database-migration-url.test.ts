import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveDatabaseMigrationUrl,
  toDirectPostgresUrl,
} from "../db/env/utils";

const pooledNeonUrl =
  "postgresql://user:secret@ep-cool-name-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";
const directNeonUrl =
  "postgresql://user:secret@ep-cool-name.us-east-1.aws.neon.tech/neondb?sslmode=require";
const localUrl = "postgresql://postgres:postgres@127.0.0.1:5432/open_instinct";

describe("toDirectPostgresUrl", () => {
  it("converts a Neon pooler hostname to the direct host", () => {
    expect(toDirectPostgresUrl(pooledNeonUrl)).toBe(directNeonUrl);
  });

  it("leaves a local database URL unchanged", () => {
    expect(toDirectPostgresUrl(localUrl)).toBe(localUrl);
  });
});

describe("resolveDatabaseMigrationUrl", () => {
  it("prefers DATABASE_URL_UNPOOLED when both URLs are set", () => {
    expect(resolveDatabaseMigrationUrl(directNeonUrl, pooledNeonUrl)).toBe(
      directNeonUrl
    );
  });

  it("falls back to DATABASE_URL and strips a Neon pooler host", () => {
    expect(resolveDatabaseMigrationUrl(undefined, pooledNeonUrl)).toBe(
      directNeonUrl
    );
  });

  it("rejects a missing migration URL", () => {
    expect(() => resolveDatabaseMigrationUrl(undefined, undefined)).toThrow(
      "DATABASE_URL_UNPOOLED or DATABASE_URL is required for migrations"
    );
  });
});

describe("migration environment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("DATABASE_URL", pooledNeonUrl);
    vi.stubEnv("DATABASE_URL_UNPOOLED", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("loads drizzle-kit credentials from DATABASE_URL when UNPOOLED is absent", async () => {
    const { default: drizzleConfig } = await import("../db/drizzle.config");

    expect(drizzleConfig).toMatchObject({
      dbCredentials: { url: directNeonUrl },
    });
  });

  it("keeps an explicit unpooled URL authoritative", async () => {
    vi.stubEnv("DATABASE_URL_UNPOOLED", localUrl);

    const { databaseMigrationUrl } = await import("../db/env/migration");

    expect(databaseMigrationUrl).toBe(localUrl);
  });
});
