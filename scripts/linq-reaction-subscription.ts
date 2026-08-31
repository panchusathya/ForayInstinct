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
 * Credentials must be the ones the deployment actually uses, and for a
 * Connect-managed line that is NOT a personal dashboard key. Connect provisions
 * its own Linq line, and a dashboard key authenticates fine while listing an
 * entirely different account's subscriptions — which reads as "the webhook was
 * never registered" even when inbound messages are arriving normally. So mint
 * the same app token the channel does whenever LINQ_CONNECTOR is set, and take
 * LINQ_API_KEY only for a direct-mode line (a Linq sandbox account).
 *
 * Minting needs a Vercel OIDC token, so locally run `vercel env pull` first (or
 * export VERCEL_OIDC_TOKEN); on a deployment it is already present.
 *
 * Deliberately a one-off rather than something the app does at boot: it changes
 * live provider configuration.
 */
/* oxlint-disable eslint/no-restricted-properties -- a standalone one-off script, deliberately outside the app's validated env module. */
import { getToken } from "@vercel/connect";
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

/**
 * The same resolution order as `linqAdapterConfig` in the channel, so this
 * script always talks to the account the deployment talks to.
 */
async function resolveApiKey() {
  const directKey = process.env.LINQ_API_KEY;
  const connector = process.env.LINQ_CONNECTOR;
  // Direct mode wins only when it is the mode the app is in: the channel also
  // requires the signing secret before it uses a raw key.
  if (directKey && process.env.LINQ_WEBHOOK_SECRET) {
    console.log("using LINQ_API_KEY (direct mode)");
    return directKey;
  }
  if (connector) {
    console.log(`minting a Linq app token through Connect (${connector})`);
    try {
      // Matches connectLinqCredentials(connector).apiKey().
      return await getToken(connector, { subject: { type: "app" } });
    } catch (error) {
      // The raw failure is an OIDC header complaint, which says nothing about
      // what to do about it.
      throw new Error(
        [
          `Could not mint a Linq token for ${connector}: ${error instanceof Error ? error.message : String(error)}`,
          "",
          "Connect needs a Vercel OIDC token. Run `vercel link` then `vercel env pull` in this checkout and try again; a deployment already has one.",
        ].join("\n"),
        { cause: error }
      );
    }
  }
  if (directKey) {
    throw new Error(
      "LINQ_API_KEY is set but LINQ_WEBHOOK_SECRET is not, so the app is not in direct mode. Set LINQ_CONNECTOR (run `vercel env pull`) so this script reads the same Linq account the deployment uses."
    );
  }
  throw new Error(
    "Set LINQ_CONNECTOR (run `vercel env pull` to get it, plus a Vercel OIDC token), or LINQ_API_KEY with LINQ_WEBHOOK_SECRET for a direct-mode line."
  );
}

const apiKey = await resolveApiKey();
const apply = process.argv.includes("--apply");

async function linq(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
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
  // Do not call this a missing endpoint. These credentials listing nothing is
  // far more often the wrong account than a broken deployment, and the old
  // wording sent someone hunting an outage while iMessage was replying fine.
  throw new Error(
    [
      "These Linq credentials list no webhook subscriptions.",
      "",
      "If inbound iMessages are arriving, the subscription exists and this key is simply for a different Linq account than the deployment uses. Run `vercel env pull` and re-run so LINQ_CONNECTOR mints the deployment's own token.",
      "",
      "Only if inbound messages are NOT arriving is the endpoint genuinely unregistered; attach the connector with --triggers --trigger-path /eve/v1/linq (see the README).",
    ].join("\n")
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
