/**
 * Reports whether Linq is sending us `reaction.added`, and adds it on request.
 *
 * A thumbs-up on a role card only becomes an application if the provider
 * actually delivers the reaction webhook. That subscription lives in Linq, not
 * in this repo, and the Chat SDK adapter does not re-export the helper that
 * would let it self-check at runtime — so without this the feature fails
 * silently, with no error and no log line anywhere.
 *
 *   pnpm linq:reactions            # report only, exits non-zero if missing
 *   pnpm linq:reactions --apply    # subscribe to the reaction events
 *
 * Needs LINQ_API_KEY. Deliberately a one-off rather than something the app does
 * at boot: it changes live provider configuration.
 */
/* oxlint-disable eslint/no-restricted-properties -- a standalone one-off script, deliberately outside the app's validated env module. */
import { z } from "zod";

const BASE_URL =
  process.env.LINQ_API_V3_BASE_URL ?? "https://api.linqapp.com/api/partner";
const WANTED = ["reaction.added", "reaction.removed"] as const;

const subscriptionSchema = z.object({
  id: z.string(),
  is_active: z.boolean().optional(),
  subscribed_events: z.array(z.string()).default([]),
  target_url: z.string().optional(),
});
const listSchema = z.object({ data: z.array(subscriptionSchema).default([]) });

const apiKey = process.env.LINQ_API_KEY;
if (!apiKey) {
  throw new Error(
    "LINQ_API_KEY is required. Production runs Linq through Vercel Connect, so take a key from the Linq dashboard for this one-off."
  );
}
const apply = process.argv.includes("--apply");

async function linq(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey ?? ""}`);
  headers.set("Content-Type", "application/json");
  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(
      `Linq ${init.method ?? "GET"} ${path} failed (${String(response.status)}): ${(await response.text()).slice(0, 300)}`
    );
  }
  return response.json() as Promise<unknown>;
}

const { data: subscriptions } = listSchema.parse(
  await linq("/v3/webhook-subscriptions")
);

if (!subscriptions.length) {
  throw new Error(
    "Linq has no webhook subscriptions at all, so Foray's /eve/v1/linq endpoint is not registered."
  );
}

let missing = 0;
for (const subscription of subscriptions) {
  const absent = WANTED.filter(
    (event) => !subscription.subscribed_events.includes(event)
  );
  console.log(
    [
      subscription.id,
      subscription.target_url ?? "(no url)",
      `active=${String(subscription.is_active ?? false)}`,
      absent.length ? `MISSING ${absent.join(", ")}` : "ok",
    ].join("  ")
  );
  if (!absent.length) continue;
  missing += 1;
  if (!apply) continue;

  await linq(`/v3/webhook-subscriptions/${subscription.id}`, {
    body: JSON.stringify({
      subscribed_events: [
        ...new Set([...subscription.subscribed_events, ...WANTED]),
      ],
    }),
    method: "PUT",
  });
  console.log(`  subscribed to ${absent.join(", ")}`);
}

if (missing && !apply) {
  console.log(
    "\nRe-run with --apply to subscribe. Until then a thumbs-up on a role card does nothing."
  );
  process.exitCode = 1;
}
