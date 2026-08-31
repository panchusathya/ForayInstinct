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
 * Simplest route is a token straight from the CLI:
 *
 *   vercel connect list
 *   vercel connect token <uid> --subject app
 *
 * `--subject app` matters -- the CLI defaults to `user` and Linq answers a
 * user-subject token with 401 invalid_token, because the channel authenticates
 * as the app. Otherwise set LINQ_CONNECTOR and this mints the token itself,
 * which needs a Vercel OIDC token (`vercel link` writes one into .env.local).
 *
 * Deliberately a one-off rather than something the app does at boot: it changes
 * live provider configuration.
 */
/* oxlint-disable eslint/no-restricted-properties -- a standalone one-off script, deliberately outside the app's validated env module. */
import { getToken } from "@vercel/connect";
import { z } from "zod";

// `vercel env pull` writes .env.local, and plain `node` does not read it, so
// without this the token that was just pulled is invisible here. Node's own
// loader rather than `@next/env`, which is CommonJS and has no named export to
// import from an ESM script. It does not override an already-set variable, so
// anything exported in the shell still wins.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Absent is normal; the credential check below reports what is missing.
  }
}

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
  const suppliedToken = process.env.LINQ_ACCESS_TOKEN;
  const directKey = process.env.LINQ_API_KEY;
  const connector = process.env.LINQ_CONNECTOR;
  // An already-minted Connect token, for when this cannot reach Connect itself
  // (no OIDC token to hand, or LINQ_CONNECTOR lives only in the production
  // environment): `vercel connect token <connector-uid>` prints one.
  if (suppliedToken) {
    console.log("using LINQ_ACCESS_TOKEN as supplied");
    return suppliedToken;
  }
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
      [
        "LINQ_API_KEY is set but LINQ_WEBHOOK_SECRET is not, so the app is not in direct mode and a personal dashboard key would read the wrong Linq account.",
        "",
        "Use the deployment's own credentials instead:",
        "  vercel connect list                     # find the linq connector uid",
        "  vercel connect token <uid> --subject app   # print the app-subject token",
        "then set LINQ_ACCESS_TOKEN to it, or set LINQ_CONNECTOR and let this mint one.",
        "`--subject app` is required: the CLI defaults to `user`, and Linq answers a user-subject token with 401 invalid_token because the channel authenticates as the app.",
      ].join("\n")
    );
  }
  throw new Error(
    [
      "No Linq credentials for the deployment's account.",
      "",
      "LINQ_CONNECTOR is commonly set only in the production environment, so a development `vercel env pull` will not include it. Either way:",
      "  vercel connect list                     # find the linq connector uid",
      "  vercel connect token <uid> --subject app   # print the app-subject token",
      "then set LINQ_ACCESS_TOKEN to it.",
      "`--subject app` is required: the CLI defaults to `user`, and Linq answers a user-subject token with 401 invalid_token because the channel authenticates as the app.",
      "Or set LINQ_CONNECTOR yourself and this mints one, which needs VERCEL_OIDC_TOKEN (vercel link writes one into .env.local).",
    ].join("\n")
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
      "If inbound iMessages are arriving, the subscription exists and these credentials are simply for a different Linq account than the deployment uses. Get the deployment's own token with `vercel connect token <uid> --subject app` and set LINQ_ACCESS_TOKEN to it.",
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
