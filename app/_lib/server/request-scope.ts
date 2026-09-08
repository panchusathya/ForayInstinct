import { headers } from "next/headers";
import { scopesForAuthUser, type AccessScope } from "@/lib/access-scope";
import { getAuthSession } from "@/auth/session";
import { adoptLegacyWorkspace } from "@/db/services/adopt-legacy-workspace";

export async function requireRequestScope(): Promise<AccessScope> {
  const session = await getAuthSession(await headers());
  if (!session) throw new UnauthenticatedError();
  const { legacyScopes, scope } = scopesForAuthUser(session.user);
  if (legacyScopes.length > 0) await adoptLegacyWorkspace(scope, legacyScopes);
  return scope;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Sign in to continue.");
    this.name = "UnauthenticatedError";
  }
}

export function unauthorizedResponse() {
  return Response.json({ error: "Sign in to continue." }, { status: 401 });
}
