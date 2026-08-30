import { inflateRawSync } from "node:zlib";

const maxExtractedCharacters = 8_000;

/**
 * Pulls readable text from a stored candidate file for eve recall.
 * This is a bounded extractor, not a layout-faithful parser: enough to fill
 * forms from a resume without sending raw bytes to the model.
 */
export function extractDocumentText(
  bytes: Buffer,
  mimeType: string,
  filename: string
) {
  const name = filename.toLowerCase();
  if (mimeType.startsWith("text/") || /\.(txt|md)$/u.test(name)) {
    return clipExtractedText(bytes.toString("utf8"));
  }
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    return clipExtractedText(extractDocxText(bytes));
  }
  if (mimeType === "application/pdf" || name.endsWith(".pdf")) {
    return clipExtractedText(extractPdfText(bytes));
  }
  return "";
}

function clipExtractedText(value: string) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxExtractedCharacters) return normalized;
  return `${normalized.slice(0, maxExtractedCharacters - 1).trimEnd()}…`;
}

function extractPdfText(bytes: Buffer) {
  const latin1 = bytes.toString("latin1");
  const chunks: string[] = [];
  for (const match of latin1.matchAll(/\((?:\\.|[^\\)]){2,}\)/gu)) {
    const decoded = unescapePdfString(match[0].slice(1, -1));
    if (/[\p{L}\p{N}]/u.test(decoded)) chunks.push(decoded);
  }
  return chunks.join(" ");
}

function unescapePdfString(value: string) {
  return value
    .replace(/\\n/gu, "\n")
    .replace(/\\r/gu, "\r")
    .replace(/\\t/gu, "\t")
    .replace(/\\([()\\])/gu, "$1");
}

function extractDocxText(bytes: Buffer) {
  const xml = zipEntry(bytes, "word/document.xml");
  if (!xml) return "";
  return xml
    .toString("utf8")
    .replace(/<w:tab\b[^/]*\/>/gu, "\t")
    .replace(/<\/w:p>/gu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#(\d+);/gu, (_, code: string) =>
      String.fromCharCode(Number(code))
    );
}

function zipEntry(bytes: Buffer, name: string) {
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50) return;
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const entryName = bytes
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) return;
    if (entryName === name) {
      const payload = bytes.subarray(dataStart, dataEnd);
      if (method === 0) return Buffer.from(payload);
      if (method === 8) return inflateRawSync(payload);
      return;
    }
    offset = dataEnd;
  }
}
