import type { Attachment } from "chat";

const docxMimeType =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const pdfMimeType = "application/pdf";

export async function readLinqAttachment(attachment: Attachment) {
  if (attachment.data instanceof Buffer) {
    return {
      bytes: attachment.data,
      resolvedMimeType: attachment.mimeType ?? "",
    };
  }
  if (attachment.data instanceof Blob) {
    return {
      bytes: Buffer.from(await attachment.data.arrayBuffer()),
      resolvedMimeType: attachment.mimeType ?? attachment.data.type,
    };
  }
  if (attachment.fetchData) {
    return {
      bytes: await attachment.fetchData(),
      resolvedMimeType: attachment.mimeType ?? "",
    };
  }
  if (!attachment.url) throw new Error("the attachment has no download URL");

  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    resolvedMimeType: response.headers.get("content-type") ?? "",
  };
}

/** Retries the same already-downloaded attachment once before surfacing a save failure. */
export async function retryLinqResumeSave<T>(save: () => Promise<T>) {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await save();
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

/**
 * Linq occasionally omits a useful filename or reports a PDF as generic
 * binary data. Identify supported documents from their bytes so a valid
 * iMessage PDF is never skipped solely because its transport metadata is thin.
 */
export function normalizeLinqDocument(input: {
  readonly bytes: Buffer;
  readonly filename: string;
  readonly mimeType: string;
}) {
  const mimeType = input.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const filename = input.filename.trim() || "resume";
  const pdf =
    mimeType === pdfMimeType ||
    /\.pdf$/iu.test(filename) ||
    input.bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (pdf) {
    return {
      filename: /\.pdf$/iu.test(filename) ? filename : `${filename}.pdf`,
      mimeType: pdfMimeType,
    };
  }

  const docx = mimeType === docxMimeType || /\.docx$/iu.test(filename);
  if (docx) {
    return {
      filename: /\.docx$/iu.test(filename) ? filename : `${filename}.docx`,
      mimeType: docxMimeType,
    };
  }
}
