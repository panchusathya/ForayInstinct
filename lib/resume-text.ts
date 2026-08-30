import { extractText, getDocumentProxy } from "unpdf";

/**
 * Plain text of a candidate's resume, kept so the agent can ground an answer
 * about their own experience instead of inventing one. The bytes themselves
 * stay out of model context; only this text is ever returned to a model.
 */

const docxMediaType =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Bounded so one pathological upload cannot dominate a model turn. */
const maxCharacters = 24_000;

function isDocx(mediaType: string, filename: string) {
  return mediaType === docxMediaType || /\.docx$/iu.test(filename);
}

function isPdf(mediaType: string, filename: string) {
  return mediaType === "application/pdf" || /\.pdf$/iu.test(filename);
}

export async function extractResumeText({
  bytes,
  filename,
  mediaType,
}: {
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
}): Promise<string> {
  const raw = isPdf(mediaType, filename)
    ? await pdfText(bytes)
    : isDocx(mediaType, filename)
      ? await docxText(bytes)
      : "";
  return normalize(raw);
}

async function pdfText(bytes: Uint8Array) {
  const document = await getDocumentProxy(bytes);
  const { text } = await extractText(document, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

async function docxText(bytes: Uint8Array) {
  // Imported lazily: mammoth pulls in a large dependency tree that a request
  // handling a PDF should not pay for.
  const { extractRawText } = await import("mammoth");
  const result = await extractRawText({
    buffer: Buffer.from(bytes),
  });
  return result.value;
}

/** Collapses the ragged whitespace a PDF extractor emits, then bounds it. */
function normalize(value: string) {
  const collapsed = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return collapsed.length <= maxCharacters
    ? collapsed
    : `${collapsed.slice(0, maxCharacters).trimEnd()}\n[resume truncated]`;
}
