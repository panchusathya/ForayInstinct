import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import {
  candidateDocumentKindSchema,
  candidateDocumentMetaSchema,
  candidateDocumentSourceSchema,
  MAX_CANDIDATE_DOCUMENT_BYTES,
  MAX_CANDIDATE_DOCUMENTS,
  type CandidateDocumentKind,
  type CandidateDocumentMeta,
  type CandidateDocumentSource,
} from "@/lib/candidate-documents";
import { extractDocumentText } from "@/lib/document-text";
import { candidateDocuments, db } from "@/db";
import { ensureScope } from "./scope";

const metadataColumns = {
  byteSize: candidateDocuments.byteSize,
  createdAt: candidateDocuments.createdAt,
  extractedText: candidateDocuments.extractedText,
  filename: candidateDocuments.filename,
  id: candidateDocuments.id,
  isDefault: candidateDocuments.isDefault,
  kind: candidateDocuments.kind,
  mimeType: candidateDocuments.mimeType,
  sha256: candidateDocuments.sha256,
  source: candidateDocuments.source,
  updatedAt: candidateDocuments.updatedAt,
};

export async function listCandidateDocuments(scope: AccessScope) {
  const rows = await db
    .select(metadataColumns)
    .from(candidateDocuments)
    .where(eq(candidateDocuments.workspaceId, scope.workspaceId))
    .orderBy(desc(candidateDocuments.updatedAt));
  return rows.map(parseDocumentMeta);
}

export async function readCandidateDocument(
  scope: AccessScope,
  id: string
): Promise<(CandidateDocumentMeta & { readonly bytes: Buffer }) | undefined> {
  const rows = await db
    .select()
    .from(candidateDocuments)
    .where(
      and(
        eq(candidateDocuments.workspaceId, scope.workspaceId),
        eq(candidateDocuments.id, id)
      )
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) return;
  return { ...parseDocumentMeta(row), bytes: Buffer.from(row.bytes) };
}

export async function readDefaultResume(scope: AccessScope) {
  const rows = await db
    .select()
    .from(candidateDocuments)
    .where(
      and(
        eq(candidateDocuments.workspaceId, scope.workspaceId),
        eq(candidateDocuments.kind, "resume"),
        eq(candidateDocuments.isDefault, "yes")
      )
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) return;
  return { ...parseDocumentMeta(row), bytes: Buffer.from(row.bytes) };
}

export async function saveCandidateDocument(
  scope: AccessScope,
  input: {
    readonly bytes: Buffer;
    readonly filename: string;
    readonly kind?: CandidateDocumentKind;
    readonly mimeType: string;
    readonly setDefault?: boolean;
    readonly source: CandidateDocumentSource;
  }
) {
  await ensureScope(scope);
  const kind = candidateDocumentKindSchema.parse(input.kind ?? "resume");
  const source = candidateDocumentSourceSchema.parse(input.source);
  if (input.bytes.byteLength === 0) {
    throw new Error("The file is empty.");
  }
  if (input.bytes.byteLength > MAX_CANDIDATE_DOCUMENT_BYTES) {
    throw new Error("Upload a file smaller than 8 MB.");
  }

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const existing = await db
    .select(metadataColumns)
    .from(candidateDocuments)
    .where(
      and(
        eq(candidateDocuments.workspaceId, scope.workspaceId),
        eq(candidateDocuments.sha256, sha256)
      )
    )
    .limit(1);
  const duplicate = existing[0];
  if (duplicate !== undefined) {
    if (input.setDefault || kind === "resume") {
      await setDefaultCandidateDocument(scope, duplicate.id);
    }
    const refreshed = await readCandidateDocument(scope, duplicate.id);
    if (refreshed === undefined) throw new Error("Unable to save the file.");
    return { created: false, document: refreshed };
  }

  const count = await documentCount(scope);
  if (count >= MAX_CANDIDATE_DOCUMENTS) {
    throw new Error("This workspace already has 20 saved documents.");
  }

  const shouldDefault =
    kind === "resume" &&
    (input.setDefault === true || !(await hasDefaultResume(scope)));
  const now = new Date().toISOString();
  const id = randomUUID();
  const filename = safeFilename(input.filename);
  const extractedText = extractDocumentText(
    input.bytes,
    input.mimeType,
    filename
  );

  await db.transaction(async (transaction) => {
    if (shouldDefault) {
      await transaction
        .update(candidateDocuments)
        .set({ isDefault: "" })
        .where(
          and(
            eq(candidateDocuments.workspaceId, scope.workspaceId),
            eq(candidateDocuments.kind, "resume"),
            eq(candidateDocuments.isDefault, "yes")
          )
        );
    }
    await transaction.insert(candidateDocuments).values({
      byteSize: input.bytes.byteLength,
      bytes: input.bytes,
      createdAt: now,
      extractedText,
      filename,
      id,
      isDefault: shouldDefault ? "yes" : "",
      kind,
      mimeType: input.mimeType || "application/octet-stream",
      sha256,
      source,
      updatedAt: now,
      workspaceId: scope.workspaceId,
    });
  });

  const stored = await readCandidateDocument(scope, id);
  if (stored === undefined) throw new Error("Unable to save the file.");
  return { created: true, document: stored };
}

export async function setDefaultCandidateDocument(
  scope: AccessScope,
  id: string
) {
  const stored = await readCandidateDocument(scope, id);
  if (stored === undefined) throw new Error("That document is not on file.");
  if (stored.kind !== "resume") {
    throw new Error("Only a resume can be the default application file.");
  }
  await clearDefaultResume(scope);
  await db
    .update(candidateDocuments)
    .set({ isDefault: "yes", updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(candidateDocuments.workspaceId, scope.workspaceId),
        eq(candidateDocuments.id, id)
      )
    );
  return readCandidateDocument(scope, id);
}

export async function deleteCandidateDocument(scope: AccessScope, id: string) {
  const deleted = await db
    .delete(candidateDocuments)
    .where(
      and(
        eq(candidateDocuments.workspaceId, scope.workspaceId),
        eq(candidateDocuments.id, id)
      )
    )
    .returning({ id: candidateDocuments.id, kind: candidateDocuments.kind });
  if (deleted[0] === undefined)
    throw new Error("That document is not on file.");
  if (deleted[0].kind === "resume") {
    const remaining = await db
      .select({ id: candidateDocuments.id })
      .from(candidateDocuments)
      .where(
        and(
          eq(candidateDocuments.workspaceId, scope.workspaceId),
          eq(candidateDocuments.kind, "resume")
        )
      )
      .orderBy(desc(candidateDocuments.updatedAt))
      .limit(1);
    if (remaining[0] !== undefined) {
      await setDefaultCandidateDocument(scope, remaining[0].id);
    }
  }
}

async function documentCount(scope: AccessScope) {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(candidateDocuments)
    .where(eq(candidateDocuments.workspaceId, scope.workspaceId));
  return rows[0]?.count ?? 0;
}

export async function hasDefaultResume(scope: AccessScope) {
  const rows = await db
    .select({ id: candidateDocuments.id })
    .from(candidateDocuments)
    .where(
      and(
        eq(candidateDocuments.workspaceId, scope.workspaceId),
        eq(candidateDocuments.kind, "resume"),
        eq(candidateDocuments.isDefault, "yes")
      )
    )
    .limit(1);
  return rows[0] !== undefined;
}

async function clearDefaultResume(scope: AccessScope) {
  await db
    .update(candidateDocuments)
    .set({ isDefault: "" })
    .where(
      and(
        eq(candidateDocuments.workspaceId, scope.workspaceId),
        eq(candidateDocuments.kind, "resume"),
        eq(candidateDocuments.isDefault, "yes")
      )
    );
}

function parseDocumentMeta(row: {
  readonly byteSize: number;
  readonly createdAt: string;
  readonly extractedText: string;
  readonly filename: string;
  readonly id: string;
  readonly isDefault: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly source: string;
  readonly updatedAt: string;
}): CandidateDocumentMeta {
  return candidateDocumentMetaSchema.parse({
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    extractedText: row.extractedText,
    filename: row.filename,
    id: row.id,
    isDefault: row.isDefault === "yes",
    kind: row.kind,
    mimeType: row.mimeType,
    sha256: row.sha256,
    source: row.source,
    updatedAt: row.updatedAt,
  });
}

function safeFilename(value: string) {
  const trimmed = value.replaceAll("\0", "").trim() || "document";
  return trimmed.slice(-180);
}
