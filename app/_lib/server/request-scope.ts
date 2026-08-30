import { headers } from "next/headers";
import {
  accessScopeForPhone,
  accessScopeForUser,
  type AccessScope,
} from "@/lib/access-scope";
import { getAuthSession } from "@/auth/session";
import { normalizeAuthPhoneNumber } from "@/auth/phone-number";
import { adoptLegacyWorkspace } from "@/db/services/adopt-legacy-workspace";

export async function requireRequestScope(): Promise<AccessScope> {
  const session = await getAuthSession(await headers());
  if (!session) throw new UnauthenticatedError();
  const legacyScope = accessScopeForUser(`better-auth:${session.user.id}`);
  const phoneNumber = normalizeAuthPhoneNumber(session.user.phoneNumber ?? "");
  if (!phoneNumber) return legacyScope;
  const scope = accessScopeForPhone(phoneNumber);
  await adoptLegacyWorkspace(scope, [legacyScope]);
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
