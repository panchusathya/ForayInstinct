import type { UserContent } from "ai";

type FilePart = Extract<UserContent[number], { type: "file" }>;

interface ComposerFile {
  filename?: string;
  mediaType?: string;
  url: string;
}

/**
 * Turns composer attachments into byte-backed model file parts.
 *
 * The composer hands over a data: URL. Eve stages only byte-backed file parts
 * to the sandbox and restores those as bytes for the provider; a URL left in
 * `data` is passed through untouched. GLM 5.3 Flash then rejects it on every
 * AI Gateway provider ("'PDF file parts with URLs' functionality not
 * supported"), which fails the turn — and because the part lands in durable
 * session history it replays on every later turn in that conversation.
 */
export async function attachmentParts(
  files: readonly ComposerFile[]
): Promise<FilePart[]> {
  return Promise.all(
    files.map(async (file) => ({
      data: await fileBytes(file.url),
      filename: file.filename,
      mediaType: mediaType(file),
      type: "file" as const,
    }))
  );
}

/** A file the OS reported no type for still needs a concrete media type. */
function mediaType(file: ComposerFile) {
  const declared = file.mediaType?.trim();
  // Not `??`: the composer reports an unknown type as an empty string.
  if (declared === undefined || declared.length === 0) {
    return "application/octet-stream";
  }
  return declared;
}

async function fileBytes(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Unable to read the attached file.");
  return new Uint8Array(await response.arrayBuffer());
}
