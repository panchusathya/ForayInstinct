import { eveChannel } from "eve/channels/eve";
import { ForbiddenError, vercelOidc } from "eve/channels/auth";
import { isSessionOwned } from "@/db/services/sessions";
import {
  accessScopeForPhone,
  accessScopeForUser,
  type AccessScope,
} from "@/lib/access-scope";
import { getAuthSession } from "@/auth/session";
import { normalizeAuthPhoneNumber } from "@/auth/phone-number";
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
  const legacyScope = accessScopeForUser(`better-auth:${session.user.id}`);
  const phoneNumber = normalizeAuthPhoneNumber(session.user.phoneNumber ?? "");
  if (!phoneNumber) return legacyScope;
  const scope = accessScopeForPhone(phoneNumber);
  await adoptLegacyWorkspace(scope, [legacyScope]);
  return scope;
}

async function waitForSessionOwnership(scope: AccessScope, sessionId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await isSessionOwned(scope, sessionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
