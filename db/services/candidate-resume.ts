import { eq } from "drizzle-orm";
import { candidateResumes, db } from "@/db";
import type { AccessScope } from "@/lib/access-scope";

export interface StoredCandidateResume {
  characters: number;
  filename: string;
  mediaType: string;
  text: string;
  updatedAt: string;
}

/** The workspace's stored resume text, or undefined when none is held. */
export async function readCandidateResume(
  scope: AccessScope
): Promise<StoredCandidateResume | undefined> {
  const rows = await db
    .select()
    .from(candidateResumes)
    .where(eq(candidateResumes.workspaceId, scope.workspaceId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.text.length === 0) return undefined;
  return {
    characters: row.characters,
    filename: row.filename,
    mediaType: row.mediaType,
    text: row.text,
    updatedAt: row.updatedAt,
  };
}

/**
 * Replaces the stored resume text. Returns `{ stored: false }` rather than
 * throwing: extraction is a convenience on top of the upload, and a candidate
 * whose resume reached GoForay must not see the upload itself fail.
 */
export async function saveCandidateResume(
  scope: AccessScope,
  resume: { filename: string; mediaType: string; text: string }
): Promise<{ stored: boolean }> {
  const now = new Date().toISOString();
  try {
    await db
      .insert(candidateResumes)
      .values({
        characters: resume.text.length,
        createdAt: now,
        filename: resume.filename,
        mediaType: resume.mediaType,
        text: resume.text,
        updatedAt: now,
        workspaceId: scope.workspaceId,
      })
      .onConflictDoUpdate({
        target: candidateResumes.workspaceId,
        set: {
          characters: resume.text.length,
          filename: resume.filename,
          mediaType: resume.mediaType,
          text: resume.text,
          updatedAt: now,
        },
      });
    return { stored: true };
  } catch {
    return { stored: false };
  }
}
