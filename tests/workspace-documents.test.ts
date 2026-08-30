import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  inferCandidateDocumentKind,
  isCandidateDocumentFile,
} from "../lib/candidate-documents";
import { extractDocumentText } from "../lib/document-text";

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
  });

  it("stores documents locally and recalls them instead of JuiceBox parsing", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const memory = readFileSync("agent/memory/workspace.ts", "utf8");
    const chat = readFileSync("app/_components/agent-chat.tsx", "utf8");
    const resumeRoute = readFileSync("app/api/goforay/resume/route.ts", "utf8");

    expect(memory).toContain("defineMemory(");
    expect(memory).toContain("buildWorkspaceContextRecall");
    expect(instructions).toContain("workspace__remember");
    expect(instructions).toContain("save_email_attachment");
    expect(instructions).toContain("stage_workspace_document");
    expect(chat).toContain("/api/documents");
    expect(chat).not.toContain("GoForay profile");
    expect(resumeRoute).toContain("saveCandidateDocument");
    expect(resumeRoute).not.toContain("uploadCandidateResume");
  });
});
