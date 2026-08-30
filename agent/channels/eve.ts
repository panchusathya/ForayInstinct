import { eveChannel } from "eve/channels/eve";
import { ForbiddenError, UnauthenticatedError } from "eve/channels/auth";
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
        throw new UnauthenticatedError({
          code: "authentication_required",
          message: "Sign in to continue.",
        });
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
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await isSessionOwned(scope, sessionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
