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

const mimeTypeByExtension: Readonly<Record<string, string>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
  pdf: "application/pdf",
  txt: "text/plain",
};
const fallbackMimeType = "application/octet-stream";

/**
 * The type a document is stored and served as. The name decides when it has
 * a known extension, the upload's own claim counts only when it is a type we
 * accept, and anything else is an opaque download: the claimed type used to
 * be stored as given and echoed back as the download's `Content-Type`, so a
 * "resume.pdf" uploaded as `text/html` came back as a page.
 */
export function canonicalDocumentMimeType(filename: string, mimeType: string) {
  const extension = /\.([a-z0-9]+)$/iu
    .exec(filename.trim())?.[1]
    ?.toLowerCase();
  const byExtension = extension ? mimeTypeByExtension[extension] : undefined;
  if (byExtension !== undefined) return byExtension;
  const claimed = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (resumeTypes.has(claimed)) return claimed;
  if (claimed.startsWith("text/")) return "text/plain";
  return fallbackMimeType;
}

/**
 * A `Content-Disposition` the filename cannot break out of: quotes,
 * backslashes and control characters are dropped from the plain parameter,
 * and the full name travels percent-encoded in `filename*`.
 */
export function documentContentDisposition(
  filename: string,
  disposition: "attachment" | "inline" = "attachment"
) {
  const clean = filename.replaceAll(/\p{Cc}/gu, "").trim() || "document";
  const ascii = clean
    .replaceAll(/["\\]/gu, "")
    .replaceAll(/[^\x20-\x7e]/gu, "_");
  const encoded = encodeURIComponent(clean).replaceAll(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * What a file is, when its name says. A bare PDF or Word file says nothing:
 * every one of them used to be filed as a resume and made the default, so a
 * cover letter uploaded on the profile page was what the next application
 * attached. Callers with context (a resume sent in chat) supply the default.
 */
export function inferCandidateDocumentKind(
  filename: string
): CandidateDocumentKind | undefined {
  const name = filename.toLowerCase();
  if (/(cover.?letter|letter.?of.?interest)/u.test(name)) return "cover_letter";
  if (/(transcript|grades?)/u.test(name)) return "transcript";
  if (/(resume|cv)/u.test(name)) return "resume";
  if (/\.(pdf|docx)$/iu.test(name)) return undefined;
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
