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

/**
 * The URLs a document links to, which its text does not contain.
 *
 * A resume almost always shows its LinkedIn as the word "LinkedIn" with the
 * address behind the hyperlink. Text extraction reads the visible word and
 * loses the target, so the profile ended up asking a candidate to type a URL
 * their own resume was carrying. Link targets live outside the text: in a
 * PDF's annotation dictionaries, and in a DOCX's relationship file.
 */
export function extractDocumentUris(
  bytes: Buffer,
  mimeType: string,
  filename: string
): string[] {
  const name = filename.toLowerCase();
  try {
    if (
      mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      name.endsWith(".docx")
    ) {
      return uniqueUris(extractDocxUris(bytes));
    }
    if (mimeType === "application/pdf" || name.endsWith(".pdf")) {
      return uniqueUris(extractPdfUris(bytes));
    }
  } catch {
    // A malformed document still yields its text; links are a bonus.
  }
  return [];
}

function uniqueUris(values: string[]) {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = stripUnstorableCharacters(value).trim();
    // Only absolute web links. A mailto: or an internal anchor is not a
    // profile, and a relative target cannot be resolved from here.
    if (/^https?:\/\/[^\s]+$/iu.test(trimmed)) seen.add(trimmed);
  }
  return [...seen].slice(0, 50);
}

/** PDF link targets: `/URI (https://…)` inside an annotation dictionary. */
function extractPdfUris(bytes: Buffer) {
  const sources = [bytes, ...pdfContentStreams(bytes)];
  const uris: string[] = [];
  for (const source of sources) {
    const latin1 = source.toString("latin1");
    for (const match of latin1.matchAll(/\/URI\s*\((?:\\.|[^\\)])*\)/gu)) {
      const literal = match[0].slice(match[0].indexOf("(") + 1, -1);
      uris.push(decodePdfString(literal));
    }
  }
  return uris;
}

/** DOCX link targets: external relationships in the document's rels part. */
function extractDocxUris(bytes: Buffer) {
  const xml = zipEntry(bytes, "word/_rels/document.xml.rels");
  if (!xml) return [];
  const text = xml.toString("utf8");
  const uris: string[] = [];
  for (const match of text.matchAll(
    /Target="([^"]+)"[^>]*TargetMode="External"/gu
  )) {
    if (match[1]) uris.push(decodeXmlEntities(match[1]));
  }
  for (const match of text.matchAll(
    /TargetMode="External"[^>]*Target="([^"]+)"/gu
  )) {
    if (match[1]) uris.push(decodeXmlEntities(match[1]));
  }
  return uris;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#(\d+);/gu, (_, code: string) =>
      String.fromCharCode(Number(code))
    );
}

function clipExtractedText(value: string) {
  const normalized = stripUnstorableCharacters(value)
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= maxExtractedCharacters) return normalized;
  return `${normalized.slice(0, maxExtractedCharacters - 1).trimEnd()}…`;
}

/**
 * A Postgres `text` value cannot hold U+0000, and the remaining C0 controls are
 * binary noise rather than resume text. Neither is removed by the whitespace
 * collapse above, because JavaScript's `\s` does not match them.
 *
 * Every extractor returns through here, which is what makes this the guarantee
 * rather than any single decoder: PDF text has several encodings, and the ones
 * this module does not decode still reach the column as bytes.
 */
function stripUnstorableCharacters(value: string) {
  // oxlint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
}

/**
 * Page text, taken from the operators that actually draw it.
 *
 * Reading every parenthesized literal in the file instead produced font
 * names, `/Producer`, XMP metadata and outline titles, deduplicated through a
 * Set that destroyed reading order — eight thousand characters of noise from
 * which nothing could be extracted and no resume fact was ever recovered.
 * Only `Tj`, `TJ`, `'` and `"` put glyphs on a page, and only inside a
 * content stream, so those are the only literals worth having.
 */
function extractPdfText(bytes: Buffer) {
  const lines: string[] = [];
  for (const stream of pdfContentStreams(bytes)) {
    const text = extractStreamText(stream.toString("latin1"));
    if (text.trim()) lines.push(text);
  }
  return lines.join("\n");
}

/**
 * One content stream's text, in the order it is drawn.
 *
 * A PDF writes a line as a run of show operators and moves the cursor between
 * them, so the positioning operators are where the spaces and line breaks
 * come from. Without them every word runs into the next and no regex or model
 * can read the result.
 */
function extractStreamText(source: string) {
  // A show operator's operand, followed by the operator itself: a literal for
  // Tj/'/", or a bracketed array of literals and kerning numbers for TJ.
  const shown =
    /\((?:\\.|[^\\)])*\)\s*(Tj|'|")|\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ|(T\*|Td|TD|ET)/gu;
  let out = "";
  for (const match of source.matchAll(shown)) {
    if (match[3]) {
      // A cursor move ends the run. ET closes the whole text object.
      out += match[3] === "ET" ? "\n" : " ";
      continue;
    }
    if (match[2] !== undefined) {
      out += textArrayContent(match[2]);
      continue;
    }
    out += decodePdfString(match[0].slice(1, match[0].lastIndexOf(")")));
  }
  return out;
}

/**
 * A `TJ` array: literals to print, and numbers that nudge the cursor. A large
 * negative nudge is how a PDF writes a space, so it is read as one.
 */
function textArrayContent(body: string) {
  let out = "";
  for (const part of body.matchAll(/\((?:\\.|[^\\)])*\)|-?\d+(?:\.\d+)?/gu)) {
    const token = part[0];
    if (token.startsWith("(")) {
      out += decodePdfString(token.slice(1, -1));
      continue;
    }
    if (Number(token) <= -100) out += " ";
  }
  return out;
}

/**
 * Every content stream's bytes, decompressed where the PDF says they are.
 *
 * A stream that declares no filter is already plain, and one this module
 * cannot decode contributes nothing rather than failing the read.
 */
function pdfContentStreams(bytes: Buffer) {
  const source = bytes.toString("latin1");
  const results: Buffer[] = [];
  const streamPattern = /<<([\s\S]{0,8000}?)>>\s*stream\r?\n/gu;
  for (const match of source.matchAll(streamPattern)) {
    const start = match.index + match[0].length;
    const end = source.indexOf("endstream", start);
    if (end < start) continue;
    let payload = bytes.subarray(start, end);
    // PDF permits one newline immediately before endstream; it is not part of
    // the payload and breaks some otherwise-valid resumes.
    if (payload.at(-1) === 10) payload = payload.subarray(0, -1);
    if (payload.at(-1) === 13) payload = payload.subarray(0, -1);
    const dictionary = match[1] ?? "";
    if (!/\/Filter/u.test(dictionary)) {
      results.push(payload);
      continue;
    }
    if (!/FlateDecode/u.test(dictionary)) continue;
    const inflated = inflateStream(payload);
    if (inflated) results.push(inflated);
  }
  return results;
}

/** A stream may carry a raw deflate payload or a zlib-wrapped one. */
function inflateStream(payload: Buffer) {
  try {
    return inflateRawSync(payload);
  } catch {
    try {
      // Some generators emit a zlib wrapper despite declaring FlateDecode.
      return inflateSync(payload);
    } catch {
      return;
    }
  }
}

/**
 * Whether text reads like something a person wrote.
 *
 * A PDF this module cannot decode still yields characters — glyph codes,
 * operator fragments, punctuation — and a single three-letter run was enough
 * to pass the old check, so junk was handed to the model as if it were a
 * resume. Prose has many multi-letter words and is mostly letters and spaces.
 */
export function looksLikeProse(text: string) {
  const trimmed = text.trim();
  // Density, not length: a terse resume is still a resume, while a page of
  // glyph codes is not prose however much of it there is.
  if (trimmed.length < 24) return false;
  const words = trimmed.match(/[\p{L}]{3,}/gu) ?? [];
  if (words.length < 4) return false;
  const readable = words.join("").length + (trimmed.match(/\s/gu)?.length ?? 0);
  return readable / trimmed.length >= 0.55;
}

/**
 * Decode one PDF literal string. Escapes are resolved against the raw bytes
 * first: a UTF-16BE string escapes any byte that happens to equal `(`, `)` or
 * `\`, so decoding before unescaping would misread those characters.
 */
function decodePdfString(value: string) {
  const bytes = Buffer.from(unescapePdfBytes(value), "latin1");
  if (bytes.length >= 4 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // One of several encodings a PDF may use for a literal string, and the one
    // a word processor tends to reach for once the text leaves plain ASCII.
    // Others exist, so this decodes what it recognizes and leaves the rest to
    // clipExtractedText: an Identity-H CID string, for instance, carries
    // two-byte glyph codes with no BOM and its own NUL bytes.
    const usable = bytes.length - ((bytes.length - 2) % 2);
    return Buffer.from(bytes.subarray(2, usable)).swap16().toString("utf16le");
  }
  return bytes.toString("latin1");
}

function unescapePdfBytes(value: string) {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (character !== "\\") {
      out += character;
      continue;
    }
    if (index + 1 >= value.length) break;
    const next = value.charAt(index + 1);
    index += 1;
    if (next === "n") {
      out += "\n";
      continue;
    }
    if (next === "r") {
      out += "\r";
      continue;
    }
    if (next === "t") {
      out += "\t";
      continue;
    }
    if (next === "b") {
      out += "\b";
      continue;
    }
    if (next === "f") {
      out += "\f";
      continue;
    }
    // A backslash before an end of line is a continuation, not a character.
    if (next === "\r") {
      if (value.charAt(index + 1) === "\n") index += 1;
      continue;
    }
    if (next === "\n") continue;
    const octal = /^[0-7]{1,3}/u.exec(value.slice(index, index + 3))?.[0];
    if (octal !== undefined) {
      out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
      index += octal.length - 1;
      continue;
    }
    out += next;
  }
  return out;
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

/** A truncated or corrupt entry yields no text rather than failing the read. */
function inflateZipEntry(payload: Buffer) {
  try {
    return inflateRawSync(payload);
  } catch {
    return;
  }
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
      if (method === 8) return inflateZipEntry(payload);
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
  for (let offset = 0; offset + 46 <= bytes.length;) {
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
      const dataStart =
        localHeaderOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) return;
      const payload = bytes.subarray(dataStart, dataEnd);
      if (method === 0) return Buffer.from(payload);
      if (method === 8) return inflateZipEntry(payload);
      return;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}
