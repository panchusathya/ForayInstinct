import {
  isE164PhoneNumber,
  legacyNormalizeAuthPhoneNumber,
  normalizeAuthPhoneNumber,
} from "@/auth/phone-number";
import { createHash } from "node:crypto";
import type { ConnectionPrincipal } from "eve/connections";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

const principalScopeSchema = z.object({
  attributes: z.object({
    workspaceId: z.string().min(1),
  }),
  id: z.string().min(1).optional(),
  principalId: z.string().min(1).optional(),
});

export interface AccessScope {
  readonly userId: string;
  readonly workspaceId: string;
}

export function accessScopeForUser(userId: string): AccessScope {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error("An authenticated user is required.");

  return {
    userId: normalizedUserId,
    workspaceId: `personal:${createHash("sha256")
      .update(normalizedUserId)
      .digest("hex")
      .slice(0, 32)}`,
  };
}

/**
 * A phone is the candidate's durable identity across iMessage and the web.
 * Keep the value out of both database ids and logs: only its stable digest is
 * ever persisted as the workspace/user id.
 */
export function accessScopeForPhone(phoneNumber: string): AccessScope {
  const normalizedPhoneNumber = phoneNumber.trim();
  if (!isE164PhoneNumber(normalizedPhoneNumber)) {
    throw new Error("A normalized phone number is required.");
  }
  const digest = createHash("sha256")
    .update(normalizedPhoneNumber)
    .digest("hex")
    .slice(0, 32);
  return { userId: `phone:${digest}`, workspaceId: `phone:${digest}` };
}

/**
 * The workspace a signed-in user works in, and the ones it absorbs.
 *
 * A verified phone is the canonical identity. The provider-keyed personal
 * workspace from before that, and a workspace keyed by the old reading of the
 * number (which put +1 in front of anything without a country code), are
 * adopted into it. Without a usable phone the user keeps whichever of those
 * they have. Three callers derived this separately and drifted: one adopted
 * the legacy phone workspace, one did not, and the page stamped the personal
 * id while the API used the phone one.
 */
export function scopesForAuthUser(user: {
  readonly id: string;
  readonly phoneNumber?: string | null;
}): { legacyScopes: AccessScope[]; scope: AccessScope } {
  const legacyScope = accessScopeForUser(`better-auth:${user.id}`);
  const stored = user.phoneNumber ?? "";
  const phoneNumber = normalizeAuthPhoneNumber(stored);
  const legacyPhone = legacyNormalizeAuthPhoneNumber(stored);
  const legacyPhoneScope =
    legacyPhone && legacyPhone !== phoneNumber
      ? accessScopeForPhone(legacyPhone)
      : undefined;
  if (!phoneNumber) {
    return { legacyScopes: [], scope: legacyPhoneScope ?? legacyScope };
  }
  return {
    legacyScopes: [
      legacyScope,
      ...(legacyPhoneScope ? [legacyPhoneScope] : []),
    ],
    scope: accessScopeForPhone(phoneNumber),
  };
}

export function scopeFromPrincipal(
  input: SessionAuthContext | Extract<ConnectionPrincipal, { type: "user" }>
) {
  const principal = principalScopeSchema.parse(input);
  const userId = principal.id ?? principal.principalId;
  if (!userId) {
    throw new Error("An authenticated workspace user is required.");
  }

  return {
    userId,
    workspaceId: principal.attributes.workspaceId,
  } satisfies AccessScope;
}
