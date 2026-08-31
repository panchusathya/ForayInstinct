import { auth } from "@googleapis/gmail";
import { connect, type EveAuthorizationOptions } from "@vercel/connect/eve";
import type { ToolContext } from "eve/tools";
import { env } from "@/lib/env";
import {
  googleWorkspaceSubject,
  GOOGLE_WORKSPACE_SCOPES,
} from "@/lib/google-workspace/config";

export const googleWorkspaceAuthOptions = {
  connector: env.GOOGLE_CONNECTOR_UID,
  createSubject(principal) {
    if (principal.type !== "user") {
      throw new Error(
        "Google Workspace requires an authenticated OpenInstinct user."
      );
    }
    return googleWorkspaceSubject(principal.id);
  },
  tokenParams: { scopes: [...GOOGLE_WORKSPACE_SCOPES] },
  validate: true,
} satisfies EveAuthorizationOptions;

const googleWorkspaceAuth = connect(googleWorkspaceAuthOptions);

export async function getGoogleAuthClient(ctx: ToolContext) {
  const { token } = await ctx.getToken(googleWorkspaceAuth);
  const authClient = new auth.OAuth2();
  authClient.setCredentials({ access_token: token });
  return authClient;
}

export async function withGoogleAuth<T>(
  ctx: ToolContext,
  execute: (authClient: InstanceType<typeof auth.OAuth2>) => Promise<T>
) {
  const authClient = await getGoogleAuthClient(ctx);
  try {
    return await execute(authClient);
  } catch (error) {
    if (googleApiErrorStatus(error) === 401) {
      ctx.requireAuth(googleWorkspaceAuth);
    }
    throw error;
  }
}

/** What a tool returns instead of starting Google consent mid-task. */
export function googleDisconnectedResult(instruction: string) {
  return {
    connectUrl: new URL("/", env.BETTER_AUTH_URL).toString(),
    message: `Google is not connected for this candidate. ${instruction} Never show the candidate an authorization code or a connect.vercel.com URL.`,
    status: "disconnected" as const,
  };
}

export function googleApiErrorStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("response" in error)) return;
  const { response } = error;
  if (!response || typeof response !== "object" || !("status" in response)) {
    return;
  }
  return typeof response.status === "number" ? response.status : undefined;
}

export function isMissingGoogleGrant(error: unknown) {
  if (googleApiErrorStatus(error) === 401) return true;
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  // Connect names these errors NoValidTokenError,
  // UserAuthorizationRequiredError, and ConnectionAuthorizationRequiredError.
  // Match the shape rather than that exact list: a rename upstream would
  // otherwise turn every graceful fallback back into a pairing-code prompt.
  return (
    typeof error.name === "string" &&
    /AuthorizationRequired|NoValidToken|NoGrant/u.test(error.name)
  );
}
