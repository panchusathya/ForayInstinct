import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractDocumentUris } from "@/lib/document-text";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn<(_input: unknown) => Promise<{ text: string }>>(),
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  gateway: () => ({}),
  wrapLanguageModel: () => ({}),
}));

vi.mock("@/lib/model-config", () => ({
  browserLanguageModel: "vision-model",
  chatLanguageModel: "text-model",
}));

const { contactFactsPatch, resumeUris } = await import("@/lib/resume-profile");

/**
 * A resume shows its LinkedIn as a word and keeps the address in the link
 * annotation, so the extracted text never contains the URL.
 */
function pdfWithLink(uri: string) {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n` +
      `2 0 obj\n<< /Type /Annot /Subtype /Link /A << /S /URI /URI (${uri}) >> >>\nendobj\n` +
      `trailer\n<< /Root 1 0 R >>\n%%EOF`,
    "latin1"
  );
}

/** A minimal stored-entry zip, which is all the DOCX reader needs. */
function storedZip(name: string, content: string) {
  const nameBytes = Buffer.from(name, "utf8");
  const data = Buffer.from(content, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(data.byteLength, 18);
  header.writeUInt16LE(nameBytes.byteLength, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes, data]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the links a document carries but does not print", () => {
  it("reads a PDF's link annotations", () => {
    const bytes = pdfWithLink("https://www.linkedin.com/in/sathya-panchu");

    expect(extractDocumentUris(bytes, "application/pdf", "resume.pdf")).toEqual(
      ["https://www.linkedin.com/in/sathya-panchu"]
    );
  });

  it("reads a DOCX's external relationships", () => {
    const bytes = storedZip(
      "word/_rels/document.xml.rels",
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" ' +
        'Target="https://www.linkedin.com/in/sathya-panchu" ' +
        'TargetMode="External"/></Relationships>'
    );

    expect(
      extractDocumentUris(
        bytes,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "resume.docx"
      )
    ).toEqual(["https://www.linkedin.com/in/sathya-panchu"]);
  });

  it("keeps only absolute web links", () => {
    // A mailto: is not a profile and an internal anchor is not resolvable.
    const bytes = pdfWithLink("mailto:sathya@example.com");

    expect(extractDocumentUris(bytes, "application/pdf", "r.pdf")).toEqual([]);
    expect(
      extractDocumentUris(Buffer.from("not a pdf"), "text/plain", "r.txt")
    ).toEqual([]);
  });

  it("never fails a read on a malformed document", () => {
    expect(
      extractDocumentUris(
        Buffer.from("%PDF-1.4 broken"),
        "application/pdf",
        "r.pdf"
      )
    ).toEqual([]);
  });
});

describe("reading a resume that hyperlinks its profile", () => {
  const resume = {
    bytes: pdfWithLink("https://www.linkedin.com/in/sathya-panchu"),
    extractedText: "Sathya Panchu Strategic Finance LinkedIn San Francisco, CA",
    filename: "resume.pdf",
    mimeType: "application/pdf",
  };

  it("finds the address behind the word, with no model call", () => {
    // The text says "LinkedIn" and nothing more, which is why the runner kept
    // asking the candidate to type a URL their own resume was carrying.
    expect(resumeUris(resume)).toEqual([
      "https://www.linkedin.com/in/sathya-panchu",
    ]);
    expect(contactFactsPatch(resume)?.links).toEqual([
      { label: "LinkedIn", url: "https://www.linkedin.com/in/sathya-panchu" },
    ]);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("has nothing to offer when the document carries no link", () => {
    expect(
      contactFactsPatch({
        extractedText: "Sathya Panchu Strategic Finance",
        mimeType: "application/pdf",
      })
    ).toBeUndefined();
  });
});
