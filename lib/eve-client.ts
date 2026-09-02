import { Client } from "eve/client";
import { getVercelOidcToken } from "@vercel/oidc";
import { env } from "@/lib/env";

/**
 * Server-side eve client for acting on a session from outside its own turn:
 * cancelling a runaway turn, retiring an idle session, or answering a prompt
 * on the candidate's behalf. Authenticated with the deployment's own OIDC
 * identity, which `agent/channels/eve.ts` admits.
 */
export function eveSessionClient() {
  return new Client({
    auth: {
      vercelOidc: { token: () => getVercelOidcToken() },
    },
    host: env.BETTER_AUTH_URL,
    redirect: "error",
  });
}
