import { z } from "zod";

export const candidateDocumentKindSchema = z.enum([
  "resume",
  "cover_letter",
  "transcript",
  "other",
]);
export type CandidateDocumentKind = z.infer<typeof candidateDocumentKindSchema>;

export const candidateDocumentSourceSchema = z.enum([
  "upload",
  "gmail",
  "linq",
  "goforay",
]);
export type CandidateDocumentSource = z.infer<
  typeof candidateDocumentSourceSchema
>;

export const MAX_CANDIDATE_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_CANDIDATE_DOCUMENTS = 20;

const resumeTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export function isCandidateDocumentFile(filename: string, mimeType: string) {
  return (
    resumeTypes.has(mimeType) ||
    mimeType.startsWith("text/") ||
    /\.(pdf|docx|txt|md)$/iu.test(filename)
  );
}

export function inferCandidateDocumentKind(
  filename: string
): CandidateDocumentKind {
  const name = filename.toLowerCase();
  if (/(cover.?letter|letter.?of.?interest)/u.test(name)) return "cover_letter";
  if (/(transcript|grades?)/u.test(name)) return "transcript";
  if (/\.(pdf|docx)$/iu.test(name) || /(resume|cv)/u.test(name))
    return "resume";
  return "other";
}

export const candidateDocumentMetaSchema = z.object({
  byteSize: z.number().int().positive(),
  createdAt: z.string(),
  extractedText: z.string(),
  filename: z.string(),
  id: z.string(),
  isDefault: z.boolean(),
  kind: candidateDocumentKindSchema,
  mimeType: z.string(),
  sha256: z.string(),
  source: candidateDocumentSourceSchema,
  updatedAt: z.string(),
});
export type CandidateDocumentMeta = z.infer<typeof candidateDocumentMetaSchema>;

export const candidateDocumentListSchema = z.object({
  documents: candidateDocumentMetaSchema.array(),
});

export function formatDocumentBytes(byteSize: number) {
  if (byteSize < 1024) return `${String(byteSize)} B`;
  if (byteSize < 1024 * 1024) {
    return `${(byteSize / 1024).toFixed(1).replace(/\.0$/u, "")} KB`;
  }
  return `${(byteSize / (1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} MB`;
}
