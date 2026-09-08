import { headers } from "next/headers";
import {
  accessScopeForPhone,
  accessScopeForUser,
  type AccessScope,
} from "@/lib/access-scope";
import { getAuthSession } from "@/auth/session";
import {
  legacyNormalizeAuthPhoneNumber,
  normalizeAuthPhoneNumber,
} from "@/auth/phone-number";
import { adoptLegacyWorkspace } from "@/db/services/adopt-legacy-workspace";

export async function requireRequestScope(): Promise<AccessScope> {
  const session = await getAuthSession(await headers());
  if (!session) throw new UnauthenticatedError();
  const legacyScope = accessScopeForUser(`better-auth:${session.user.id}`);
  const stored = session.user.phoneNumber ?? "";
  const phoneNumber = normalizeAuthPhoneNumber(stored);
  // A workspace keyed by the old reading of the number (which put +1 in
  // front of anything without a country code) is adopted into the corrected
  // one, or kept when the corrected reading gives nothing.
  const legacyPhone = legacyNormalizeAuthPhoneNumber(stored);
  const legacyPhoneScope =
    legacyPhone && legacyPhone !== phoneNumber
      ? accessScopeForPhone(legacyPhone)
      : undefined;
  if (!phoneNumber) return legacyPhoneScope ?? legacyScope;
  const scope = accessScopeForPhone(phoneNumber);
  await adoptLegacyWorkspace(scope, [
    legacyScope,
    ...(legacyPhoneScope ? [legacyPhoneScope] : []),
  ]);
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
