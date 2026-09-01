import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { db, encryptedSecrets } from "@/db";

export type SecretNamespace = "browser-state" | "vault";

export async function writeEncryptedSecret(
  scope: AccessScope,
  namespace: SecretNamespace,
  id: string,
  encryptedValue: string
) {
  const updatedAt = new Date().toISOString();
  await db
    .insert(encryptedSecrets)
    .values({
      encryptedValue,
      id,
      namespace,
      updatedAt,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: [
        encryptedSecrets.workspaceId,
        encryptedSecrets.namespace,
        encryptedSecrets.id,
      ],
      set: { encryptedValue, updatedAt },
    });
}

export async function readEncryptedSecret(
  scope: AccessScope,
  namespace: SecretNamespace,
  id: string
) {
  const rows = await db
    .select({ encryptedValue: encryptedSecrets.encryptedValue })
    .from(encryptedSecrets)
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, namespace),
        eq(encryptedSecrets.id, id)
      )
    )
    .limit(1);
  return rows[0]?.encryptedValue;
}

export async function deleteEncryptedSecret(
  scope: AccessScope,
  namespace: SecretNamespace,
  id: string
) {
  await db
    .delete(encryptedSecrets)
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, namespace),
        eq(encryptedSecrets.id, id)
      )
    );
}
