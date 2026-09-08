import { and, eq, inArray, sql } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import {
  agentSessions,
  applicationSubmissionScreenshots,
  browserRunCheckpoints,
  browserSessions,
  candidateDocuments,
  candidateProfiles,
  chats,
  db,
  encryptedSecrets,
  goforayLinks,
  goforayWorkspaceLinks,
  settings,
  vaultItems,
  workspaces,
  workspaceMemories,
  workspaceMemberships,
} from "@/db";
import { ensureScope } from "./scope";
import {
  hasDefaultResume,
  listCandidateDocuments,
  saveCandidateDocument,
} from "./candidate-documents";
import {
  canDecryptSecret,
  reencryptSecretForWorkspace,
} from "@/lib/manager/server/secret-store";
import type { SecretNamespace } from "@/db/services/secrets";

/**
 * Moves data from the provider-specific workspaces created before phone
 * identity became canonical. Idempotent, and now convergent: a legacy
 * workspace that does not exist, or that is already marked as adopted into
 * this target, costs one probe query and nothing else. The full copy used to
 * run on every request, forever, because nothing recorded that it had run.
 */
export async function adoptLegacyWorkspace(
  target: AccessScope,
  legacyScopes: readonly AccessScope[]
) {
  await ensureScope(target);
  const candidates = legacyScopes.filter(
    (legacy) => legacy.workspaceId !== target.workspaceId
  );
  if (candidates.length === 0) return;
  const pending = await pendingAdoptions(target, candidates);
  for (const legacy of pending) {
    await adoptOneWorkspace(target, legacy);
  }
}

/** The legacy workspaces that exist and have not yet been absorbed here. */
async function pendingAdoptions(
  target: AccessScope,
  candidates: readonly AccessScope[]
) {
  const rows = await db
    .select({
      adoptedInto: workspaces.adoptedIntoWorkspaceId,
      id: workspaces.id,
    })
    .from(workspaces)
    .where(
      inArray(
        workspaces.id,
        candidates.map((legacy) => legacy.workspaceId)
      )
    );
  return candidates.filter((legacy) =>
    rows.some(
      (row) =>
        row.id === legacy.workspaceId && row.adoptedInto !== target.workspaceId
    )
  );
}

async function adoptOneWorkspace(target: AccessScope, legacy: AccessScope) {
  const copied = await db.transaction(async (transaction) => {
    // Two requests from the same candidate can arrive together; only one of
    // them copies, the other waits and then finds the marker set.
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${target.workspaceId}))`
    );
    const [marker] = await transaction
      .select({ adoptedInto: workspaces.adoptedIntoWorkspaceId })
      .from(workspaces)
      .where(eq(workspaces.id, legacy.workspaceId))
      .limit(1);
    if (!marker || marker.adoptedInto === target.workspaceId) return false;

    // Browser/session ownership rows reference memberships. Retain every
    // legacy principal as an owner of the canonical workspace before rehoming
    // those records.
    const memberships = await transaction
      .select({
        createdAt: workspaceMemberships.createdAt,
        userId: workspaceMemberships.userId,
      })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, legacy.workspaceId));
    for (const membership of memberships) {
      await transaction
        .insert(workspaceMemberships)
        .values({
          createdAt: membership.createdAt,
          role: "owner",
          userId: membership.userId,
          workspaceId: target.workspaceId,
        })
        .onConflictDoNothing();
    }

    // Newer profile and remembered facts win. Settings do not have a clock,
    // so the already-canonical value wins on a collision.
    const legacyProfile = await transaction
      .select()
      .from(candidateProfiles)
      .where(eq(candidateProfiles.workspaceId, legacy.workspaceId))
      .limit(1);
    const targetProfile = await transaction
      .select({ updatedAt: candidateProfiles.updatedAt })
      .from(candidateProfiles)
      .where(eq(candidateProfiles.workspaceId, target.workspaceId))
      .limit(1);
    if (
      legacyProfile[0] &&
      (!targetProfile[0] ||
        legacyProfile[0].updatedAt > targetProfile[0].updatedAt)
    ) {
      await transaction
        .delete(candidateProfiles)
        .where(eq(candidateProfiles.workspaceId, target.workspaceId));
      await transaction.insert(candidateProfiles).values({
        ...legacyProfile[0],
        workspaceId: target.workspaceId,
      });
    }

    const legacyMemories = await transaction
      .select()
      .from(workspaceMemories)
      .where(eq(workspaceMemories.workspaceId, legacy.workspaceId));
    for (const memory of legacyMemories) {
      const existing = await transaction
        .select({ updatedAt: workspaceMemories.updatedAt })
        .from(workspaceMemories)
        .where(
          and(
            eq(workspaceMemories.workspaceId, target.workspaceId),
            eq(workspaceMemories.key, memory.key)
          )
        )
        .limit(1);
      if (!existing[0] || memory.updatedAt > existing[0].updatedAt) {
        await transaction
          .insert(workspaceMemories)
          .values({ ...memory, workspaceId: target.workspaceId })
          .onConflictDoUpdate({
            target: [workspaceMemories.workspaceId, workspaceMemories.key],
            set: { updatedAt: memory.updatedAt, value: memory.value },
          });
      }
    }

    const legacySettings = await transaction
      .select()
      .from(settings)
      .where(eq(settings.workspaceId, legacy.workspaceId));
    for (const setting of legacySettings) {
      await transaction
        .insert(settings)
        .values({ ...setting, workspaceId: target.workspaceId })
        .onConflictDoNothing();
    }

    const legacySecrets = await transaction
      .select()
      .from(encryptedSecrets)
      .where(eq(encryptedSecrets.workspaceId, legacy.workspaceId));
    for (const secret of legacySecrets) {
      const existingRows = await transaction
        .select({
          encryptedValue: encryptedSecrets.encryptedValue,
          updatedAt: encryptedSecrets.updatedAt,
        })
        .from(encryptedSecrets)
        .where(
          and(
            eq(encryptedSecrets.workspaceId, target.workspaceId),
            eq(encryptedSecrets.namespace, secret.namespace),
            eq(encryptedSecrets.id, secret.id)
          )
        )
        .limit(1);
      const existing = existingRows.at(0);
      const legacyNewer =
        existing === undefined || secret.updatedAt > existing.updatedAt;
      const upsert = (
        encryptedValue: string,
        updatedAt: typeof secret.updatedAt
      ) =>
        transaction
          .insert(encryptedSecrets)
          .values({
            ...secret,
            encryptedValue,
            workspaceId: target.workspaceId,
          })
          .onConflictDoUpdate({
            target: [
              encryptedSecrets.workspaceId,
              encryptedSecrets.namespace,
              encryptedSecrets.id,
            ],
            set: { encryptedValue, updatedAt },
          });
      if (!isSecretNamespace(secret.namespace)) {
        if (legacyNewer) await upsert(secret.encryptedValue, secret.updatedAt);
        continue;
      }
      // A target row its own AAD cannot open is a verbatim copy from before
      // secrets were re-bound on adoption. A legacy value that still reads
      // repairs it, whatever the two clocks say.
      if (
        !legacyNewer &&
        canDecryptSecret({
          ciphertext: existing.encryptedValue,
          id: secret.id,
          namespace: secret.namespace,
          scope: target,
        })
      ) {
        continue;
      }
      let encryptedValue: string;
      try {
        encryptedValue = reencryptSecretForWorkspace({
          ciphertext: secret.encryptedValue,
          from: legacy,
          id: secret.id,
          namespace: secret.namespace,
          to: target,
        });
      } catch (error) {
        // Storing the legacy bytes under the target's AAD would leave a row
        // nothing can ever open, and one that shadows a later real save.
        console.error("[adopt-legacy-workspace] could not re-encrypt secret", {
          error: error instanceof Error ? error.message : String(error),
          namespace: secret.namespace,
        });
        continue;
      }
      await upsert(
        encryptedValue,
        legacyNewer ? secret.updatedAt : existing.updatedAt
      );
    }

    await transaction
      .update(browserSessions)
      .set({ workspaceId: target.workspaceId })
      .where(eq(browserSessions.workspaceId, legacy.workspaceId));
    await transaction
      .update(browserRunCheckpoints)
      .set({ workspaceId: target.workspaceId })
      .where(eq(browserRunCheckpoints.workspaceId, legacy.workspaceId));
    await transaction
      .update(chats)
      .set({ workspaceId: target.workspaceId })
      .where(eq(chats.workspaceId, legacy.workspaceId));
    await transaction
      .update(agentSessions)
      .set({ workspaceId: target.workspaceId })
      .where(eq(agentSessions.workspaceId, legacy.workspaceId));
    await transaction
      .update(applicationSubmissionScreenshots)
      .set({ workspaceId: target.workspaceId })
      .where(
        eq(applicationSubmissionScreenshots.workspaceId, legacy.workspaceId)
      );
    await transaction
      .update(vaultItems)
      .set({ workspaceId: target.workspaceId })
      .where(eq(vaultItems.workspaceId, legacy.workspaceId));

    const [targetWorkspace, legacyWorkspace] = await Promise.all([
      transaction
        .select({ kernelProfileId: workspaces.kernelProfileId })
        .from(workspaces)
        .where(eq(workspaces.id, target.workspaceId))
        .limit(1),
      transaction
        .select({ kernelProfileId: workspaces.kernelProfileId })
        .from(workspaces)
        .where(eq(workspaces.id, legacy.workspaceId))
        .limit(1),
    ]);
    if (
      !targetWorkspace[0]?.kernelProfileId &&
      legacyWorkspace[0]?.kernelProfileId
    ) {
      await transaction
        .update(workspaces)
        .set({ kernelProfileId: legacyWorkspace[0].kernelProfileId })
        .where(eq(workspaces.id, target.workspaceId));
    }

    if (legacy.userId.startsWith("better-auth:")) {
      const oldLink = await transaction
        .select({
          candidateId: goforayLinks.candidateId,
          createdAt: goforayLinks.createdAt,
          orgId: goforayLinks.orgId,
        })
        .from(goforayLinks)
        .where(
          eq(goforayLinks.userId, legacy.userId.slice("better-auth:".length))
        )
        .limit(1);
      if (oldLink[0]) {
        await transaction
          .insert(goforayWorkspaceLinks)
          .values({ ...oldLink[0], workspaceId: target.workspaceId })
          .onConflictDoNothing();
      }
    }
    return true;
  });
  if (!copied) return;

  // Documents are copied through their service so byte hashing/default rules
  // remain identical to a normal upload. Deleting only after a successful
  // save makes retries safe after a transient database error.
  const defaultAlreadyExists = await hasDefaultResume(target);
  const documents = await listCandidateDocuments(legacy);
  for (const document of documents) {
    const source = await db.query.candidateDocuments.findFirst({
      where: and(
        eq(candidateDocuments.workspaceId, legacy.workspaceId),
        eq(candidateDocuments.id, document.id)
      ),
    });
    if (!source) continue;
    await saveCandidateDocument(target, {
      bytes: Buffer.from(source.bytes),
      filename: source.filename,
      kind: document.kind,
      mimeType: source.mimeType,
      setDefault: document.isDefault && !defaultAlreadyExists,
      source: document.source,
    });
    await db
      .delete(candidateDocuments)
      .where(
        and(
          eq(candidateDocuments.workspaceId, legacy.workspaceId),
          eq(candidateDocuments.id, document.id)
        )
      );
  }

  // Marked only once everything, documents included, is across: a failure
  // above leaves the marker clear and the next request tries again.
  await db
    .update(workspaces)
    .set({ adoptedIntoWorkspaceId: target.workspaceId })
    .where(eq(workspaces.id, legacy.workspaceId));
}

function isSecretNamespace(value: string): value is SecretNamespace {
  return (
    value === "vault" ||
    value === "browser-state" ||
    value === "contact" ||
    value === "application-answers"
  );
}
