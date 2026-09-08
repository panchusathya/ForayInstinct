import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * The card route's own secret, derived from the session-signing secret so it
 * needs no setting of its own, and so the signing secret itself never travels:
 * it used to be sent in a header on every card render and compared with a
 * plain inequality, which is both a wider exposure of the one secret that can
 * forge a session and a byte-at-a-time oracle for it.
 */
export function jobCardSecret() {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update("foray:job-card-png")
    .digest("hex");
}

/** Constant-time check of the header against the derived secret. */
export function isJobCardSecret(candidate: string | null | undefined) {
  if (!candidate) return false;
  const given = Buffer.from(candidate);
  const expected = Buffer.from(jobCardSecret());
  return given.length === expected.length && timingSafeEqual(given, expected);
}
