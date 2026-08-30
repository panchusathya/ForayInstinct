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
  if (!/^\+[1-9]\d{6,14}$/u.test(normalizedPhoneNumber)) {
    throw new Error("A normalized phone number is required.");
  }
  const digest = createHash("sha256")
    .update(normalizedPhoneNumber)
    .digest("hex")
    .slice(0, 32);
  return { userId: `phone:${digest}`, workspaceId: `phone:${digest}` };
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
