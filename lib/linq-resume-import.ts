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

/**
 * SQLSTATE classes where the same bytes could still succeed: a lost or refused
 * connection, exhausted resources, an administrative interruption, or a rolled
 * back transaction. Every other class is the server rejecting this statement on
 * its merits, which a second identical attempt cannot change.
 */
const transientSqlStateClasses = new Set(["08", "40", "53", "57"]);

/** Socket faults surface from the driver without a SQLSTATE of their own. */
const transientDriverCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * Classify by the error the database actually raised rather than by its
 * message, so that rewording a validation error cannot silently change how the
 * save behaves. Drizzle wraps the driver error, so walk the cause chain.
 */
function isRetryableSaveFailure(error: unknown) {
  for (
    let cause: unknown = error, depth = 0;
    cause !== null && cause !== undefined && depth < 5;
    cause = (cause as { cause?: unknown }).cause, depth += 1
  ) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code !== "string") continue;
    if (transientDriverCodes.has(code)) return true;
    // A SQLSTATE is five alphanumeric characters, not five digits: 57P01 and
    // 40P01 are both codes this has to recognize.
    if (/^[0-9A-Z]{5}$/u.test(code)) {
      return transientSqlStateClasses.has(code.slice(0, 2));
    }
  }
  // A rejection carrying no code never reached the database: it is one of the
  // document service's own validation errors, settled by the bytes it was
  // handed, so a second identical attempt gets the same answer.
  return false;
}

/** Retries the same already-downloaded attachment once before surfacing a save failure. */
export async function retryLinqResumeSave<T>(save: () => Promise<T>) {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await save();
    } catch (error) {
      failure = error;
      if (!isRetryableSaveFailure(error)) break;
      // Give a saturated connection pool a moment before spending the retry.
      if (attempt === 0)
        await new Promise((resolve) => setTimeout(resolve, 250));
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
