import { eveChannel } from "eve/channels/eve";
import { ForbiddenError, vercelOidc } from "eve/channels/auth";
import { isSessionOwned } from "@/db/services/sessions";
import { scopesForAuthUser, type AccessScope } from "@/lib/access-scope";
import { getAuthSession } from "@/auth/session";
import { adoptLegacyWorkspace } from "@/db/services/adopt-legacy-workspace";

export default eveChannel({
  auth: [
    async (request) => {
      const scope = await requestScopeFromRequest(request);
      if (!scope) {
        // Skip to `vercelOidc()` instead of throwing. Turn-budget cancel,
        // rollover, restart, and leftover worker `session.cancel()` are
        // in-project Vercel workloads that present an OIDC token, not a cookie.
        return;
      }

      const sessionId = sessionIdFromPath(new URL(request.url).pathname);
      if (sessionId && !(await waitForSessionOwnership(scope, sessionId))) {
        throw new ForbiddenError({ message: "Session not found." });
      }

      return {
        attributes: { workspaceId: scope.workspaceId },
        authenticator: "authjs",
        principalId: scope.userId,
        principalType: "user",
      };
    },
    // The application-worker watchdog is an in-project Vercel workload. It
    // needs only Eve's fixed-session control routes, never browser/user data.
    vercelOidc(),
  ],
});

function sessionIdFromPath(pathname: string) {
  const match = /^\/eve\/v1\/session\/([^/]+)/.exec(pathname);
  if (!match?.[1]) return;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return;
  }
}

async function requestScopeFromRequest(request: Request) {
  const session = await getAuthSession(request.headers);
  if (!session) return;
  // The same derivation the API routes use, legacy-phone adoption included;
  // this path used to adopt only the personal workspace.
  const { legacyScopes, scope } = scopesForAuthUser(session.user);
  if (legacyScopes.length > 0) await adoptLegacyWorkspace(scope, legacyScopes);
  return scope;
}

async function waitForSessionOwnership(scope: AccessScope, sessionId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await isSessionOwned(scope, sessionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
