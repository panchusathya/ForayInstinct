import { inflateRawSync, inflateSync } from "node:zlib";

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
  const streams = [bytes, ...inflatePdfStreams(bytes)];
  const chunks: string[] = [];
  for (const stream of streams) {
    const latin1 = stream.toString("latin1");
    for (const match of latin1.matchAll(/\((?:\\.|[^\\)]){2,}\)/gu)) {
      const decoded = unescapePdfString(match[0].slice(1, -1));
      if (/[\p{L}\p{N}]/u.test(decoded)) chunks.push(decoded);
    }
  }
  return [...new Set(chunks)].join(" ");
}

/** Extract Flate-compressed PDF content streams without trusting layout. */
function inflatePdfStreams(bytes: Buffer) {
  const source = bytes.toString("latin1");
  const results: Buffer[] = [];
  const streamPattern = /<<[\s\S]{0,8000}?\/Filter\s*\/FlateDecode[\s\S]{0,8000}?>>\s*stream\r?\n/gu;
  for (const match of source.matchAll(streamPattern)) {
    const start = match.index + match[0].length;
    const end = source.indexOf("endstream", start);
    if (end < start) continue;
    let payload = bytes.subarray(start, end);
    // PDF permits one newline immediately before endstream; it is not part of
    // the deflate payload and breaks some otherwise-valid resumes.
    if (payload.at(-1) === 10) payload = payload.subarray(0, -1);
    if (payload.at(-1) === 13) payload = payload.subarray(0, -1);
    try {
      results.push(inflateRawSync(payload));
    } catch {
      try {
        // Some generators emit a zlib wrapper despite declaring FlateDecode.
        results.push(inflateSync(payload));
      } catch {
        // One malformed stream must not discard text from the others.
      }
    }
  }
  return results;
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
    if (bytes.readUInt32LE(offset) !== 0x04034b50) break;
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const entryName = bytes
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) break;
    if (entryName === name) {
      const payload = bytes.subarray(dataStart, dataEnd);
      if (method === 0) return Buffer.from(payload);
      if (method === 8) return inflateRawSync(payload);
      return;
    }
    offset = dataEnd;
  }
  return zipEntryFromCentralDirectory(bytes, name);
}

/**
 * DOCX writers that use data descriptors leave the local-header size as zero.
 * Their central directory remains authoritative, so use it as a fallback
 * rather than treating a perfectly ordinary resume as an empty document.
 */
function zipEntryFromCentralDirectory(bytes: Buffer, name: string) {
  for (let offset = 0; offset + 46 <= bytes.length; ) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const entryName = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (entryName === name && localHeaderOffset + 30 <= bytes.length) {
      const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) return;
      const payload = bytes.subarray(dataStart, dataEnd);
      if (method === 0) return Buffer.from(payload);
      if (method === 8) return inflateRawSync(payload);
      return;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}
