import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import {
  inferCandidateDocumentKind,
  isCandidateDocumentFile,
} from "../lib/candidate-documents";
import { extractDocumentText } from "../lib/document-text";
import {
  extractStatedFacts,
  isInternalMemoryKey,
  userMessageTexts,
} from "../lib/workspace-memory-capture";

describe("candidate documents", () => {
  it("classifies resumes, cover letters, and other files", () => {
    expect(inferCandidateDocumentKind("Ada_Lovelace_Resume.pdf")).toBe(
      "resume"
    );
    expect(inferCandidateDocumentKind("cover-letter.docx")).toBe(
      "cover_letter"
    );
    expect(inferCandidateDocumentKind("official-transcript.pdf")).toBe(
      "transcript"
    );
    expect(inferCandidateDocumentKind("notes.txt")).toBe("other");
    expect(isCandidateDocumentFile("resume.pdf", "application/pdf")).toBe(true);
    expect(isCandidateDocumentFile("photo.png", "image/png")).toBe(false);
  });

  it("extracts readable text from a plain-text file and a tiny PDF", () => {
    expect(
      extractDocumentText(
        Buffer.from("Staff engineer in Austin"),
        "text/plain",
        "notes.txt"
      )
    ).toBe("Staff engineer in Austin");
    expect(
      extractDocumentText(
        Buffer.from("%PDF-1.1\n(Ada Lovelace)\n(Staff Engineer)\n"),
        "application/pdf",
        "ada.pdf"
      )
    ).toContain("Ada Lovelace");

    const compressed = deflateSync(Buffer.from("BT (Grace Hopper) Tj ET"));
    const pdf = Buffer.concat([
      Buffer.from(
        `%PDF-1.4\n1 0 obj\n<< /Length ${String(compressed.byteLength)} /Filter /FlateDecode >>\nstream\n`,
        "latin1"
      ),
      compressed,
      Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
    ]);
    expect(extractDocumentText(pdf, "application/pdf", "grace.pdf")).toContain(
      "Grace Hopper"
    );
  });

  it("captures explicit self-statements without inferring EEO answers", () => {
    expect(
      extractStatedFacts(
        "My name is Ada Lovelace. I live in Austin, Texas and I can start ASAP. I'm looking for a staff engineer role and targeting $180k."
      )
    ).toEqual([
      { key: "stated_name", value: "Ada Lovelace" },
      { key: "location", value: "Austin, Texas" },
      { key: "earliest_start", value: "immediately" },
      { key: "target_role", value: "staff engineer role" },
      { key: "compensation_target", value: "$180k" },
    ]);
    expect(extractStatedFacts("I prefer not to say my gender.")).toEqual([]);
    expect(isInternalMemoryKey("capture.operation")).toBe(true);
    expect(isInternalMemoryKey("location")).toBe(false);
    expect(
      userMessageTexts([
        { content: "I live in Austin", role: "user" },
        { content: "Noted.", role: "assistant" },
        {
          content: [{ text: "Call me Ada", type: "text" }],
          role: "user",
        },
      ])
    ).toEqual(["I live in Austin", "Call me Ada"]);
  });

  it("stores documents locally and recalls them instead of JuiceBox parsing", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const memory = readFileSync("agent/memory/workspace.ts", "utf8");
    const chat = readFileSync("app/_components/agent-chat.tsx", "utf8");
    const resumeRoute = readFileSync("app/api/goforay/resume/route.ts", "utf8");

    expect(memory).toContain("defineMemory(");
    expect(memory).toContain("buildWorkspaceContextRecall");
    expect(memory).toContain('"turn.completed"');
    expect(memory).toContain("observeWorkspaceConversation");
    expect(instructions).toContain("workspace__remember");
    expect(instructions).toContain("save_email_attachment");
    expect(instructions).toContain("stage_workspace_document");
    expect(chat).toContain("/api/documents");
    expect(chat).not.toContain("GoForay profile");
    expect(resumeRoute).toContain("saveCandidateDocument");
    expect(resumeRoute).not.toContain("uploadCandidateResume");
  });
});
