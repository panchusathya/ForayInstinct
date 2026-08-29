import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { isE164PhoneNumber } from "../auth/phone-number";
import { databaseUrlSchema } from "../db/env/utils";

const localDevelopment =
  process.env.NODE_ENV === "development" &&
  process.env.VERCEL_ENV === undefined;

const requiredValue = z
  .string()
  .refine((value) => value.trim().length > 0, "Required");

const betterAuthUrlSchema = requiredValue.refine(
  (value) => URL.canParse(value),
  "BETTER_AUTH_URL must be an absolute URL"
);

const secretEncryptionKeySchema = requiredValue.refine(
  (value) => Buffer.from(value, "base64").length === 32,
  "SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key."
);

function requiredValueWithLocalDefault<T extends z.ZodType<string, string>>(
  schema: T,
  localDefault: z.util.NoUndefined<z.output<T>>
) {
  return localDevelopment ? schema.default(localDefault) : schema;
}

export const env = createEnv({
  server: {
    // Required
    DATABASE_URL: databaseUrlSchema,
    // Bright Data Browser API credentials (`customer-zone:password`). Worker
    // browsers connect over CDP; `-session-<id>` is appended so later tool
    // calls can resume the same hosted Chrome.
    BRIGHT_DATA_BROWSER_AUTH: requiredValue.refine(
      (value) => value.includes(":"),
      "BRIGHT_DATA_BROWSER_AUTH must be `username:password`."
    ),
    // Decodo residential proxy URL. Traffic from the hosted browser uses this
    // sticky residential exit instead of a shared ISP pool.
    DECODO_PROXY_URL: z.url().refine((value) => {
      const url = new URL(value);
      return url.username.length > 0 && url.password.length > 0;
    }, "DECODO_PROXY_URL must include a username and password."),
    // Vercel's automatic free allowance is deliberately not enough for the
    // candidate agent. A named paid Gateway key makes the routing and billing
    // relationship explicit instead of silently falling back to a free model.
    AI_GATEWAY_API_KEY: requiredValueWithLocalDefault(
      requiredValue,
      "openinstinct-local-ai-gateway-key"
    ),

    // Required with local defaults
    BETTER_AUTH_SECRET: requiredValueWithLocalDefault(
      requiredValue,
      "openinstinct-local-auth-development-secret"
    ),
    BETTER_AUTH_URL: requiredValueWithLocalDefault(
      betterAuthUrlSchema,
      "http://localhost:3000"
    ),
    SECRET_ENCRYPTION_KEY: requiredValueWithLocalDefault(
      secretEncryptionKeySchema,
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    ),

    // GoForay bridge. Empty keeps the upstream OpenInstinct experience
    // usable; deployed candidate workflows require both values.
    EXA_API_KEY: requiredValue.optional(),
    JUICEBOX_API_URL: z.url().optional(),
    OPENINSTINCT_SHARED_SECRET: z.string().min(32).optional(),

    // Optional
    GOOGLE_CONNECTOR_UID: requiredValue.default("google/open-instinct"),
    // Linq can run either through Vercel Connect or directly. Direct mode is
    // useful for Linq sandbox accounts, where the provider must call the Eve
    // endpoint itself instead of forwarding through Connect.
    LINQ_API_KEY: requiredValue.optional(),
    LINQ_WEBHOOK_SECRET: requiredValue.optional(),
    LINQ_CONNECTOR: requiredValue.optional(),
    LINQ_PHONE_NUMBER: requiredValue
      .refine(
        (value) => isE164PhoneNumber(value),
        "LINQ_PHONE_NUMBER must use E.164 format"
      )
      .optional(),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("production"),
    VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  },
  experimental__runtimeEnv: {},
  emptyStringAsUndefined: true,
});

if (
  env.LINQ_PHONE_NUMBER !== undefined &&
  env.LINQ_CONNECTOR === undefined &&
  env.LINQ_API_KEY === undefined
) {
  throw new Error("LINQ_PHONE_NUMBER requires LINQ_CONNECTOR or LINQ_API_KEY.");
}

if (
  (env.LINQ_API_KEY === undefined) !==
  (env.LINQ_WEBHOOK_SECRET === undefined)
) {
  throw new Error(
    "LINQ_API_KEY and LINQ_WEBHOOK_SECRET must be configured together."
  );
}
const authHostname = new URL(env.BETTER_AUTH_URL).hostname;

export const localPhoneAuthBypassEnabled =
  localDevelopment &&
  (authHostname === "localhost" ||
    authHostname === "127.0.0.1" ||
    authHostname === "[::1]");
