import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractResumeText } from "@/lib/resume-text";

/** Smallest valid PDF carrying one text run, built inline so the test owns it. */
function onePagePdf(body: string) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${String(body.length)} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

describe("resume text extraction", () => {
  it("reads the text out of a PDF resume", async () => {
    const bytes = onePagePdf(
      "BT /F1 12 Tf 72 720 Td (Corporate Development Analyst) Tj ET"
    );

    const text = await extractResumeText({
      bytes,
      filename: "resume.pdf",
      mediaType: "application/pdf",
    });

    expect(text).toContain("Corporate Development Analyst");
  });

  it("returns empty text for a file type it cannot read", async () => {
    const text = await extractResumeText({
      bytes: new Uint8Array([1, 2, 3]),
      filename: "resume.rtf",
      mediaType: "application/rtf",
    });

    expect(text).toBe("");
  });

  it("bounds a very long resume so it cannot dominate a turn", async () => {
    // Many separate text runs, so extraction reliably yields more than the
    // bound rather than depending on how one long string is laid out.
    const bytes = onePagePdf(
      Array.from(
        { length: 3_000 },
        () =>
          "BT /F1 12 Tf 72 720 Td (senior corporate development analyst) Tj ET"
      ).join("\n")
    );

    const text = await extractResumeText({
      bytes,
      filename: "resume.pdf",
      mediaType: "application/pdf",
    });

    expect(text.length).toBeLessThanOrEqual(24_100);
    expect(text).toContain("[resume truncated]");
  });

  it("names the profile sections a resume can fill", async () => {
    const { candidateProfileSchema, resumeFillableProfileGaps } =
      await import("@/lib/candidate-profile");

    const empty = candidateProfileSchema.parse({});
    expect(resumeFillableProfileGaps(empty)).toEqual([
      "work history",
      "education",
      "skills",
      "headline",
      "summary",
      "links",
    ]);

    const filled = candidateProfileSchema.parse({
      headline: "Corporate development analyst",
      skills: ["valuation", "diligence"],
      workHistory: [{ company: "Example Co", current: true, title: "Analyst" }],
    });
    // Only the sections still empty are reported, so the agent fills those
    // and leaves what the candidate already curated alone.
    expect(resumeFillableProfileGaps(filled)).toEqual([
      "education",
      "summary",
      "links",
    ]);
  });

  it("tells the agent to ground written answers in the stored resume", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");

    expect(instructions).toContain("`candidate_resume`");
    expect(instructions).toContain("durable memory of this candidate");
    expect(instructions).toContain("Never invent an employer, title, date");
    expect(instructions).toContain("Never ask them to\n  retype");
    expect(instructions).toContain("`profile_gaps`");
    expect(instructions).toContain(
      "never ask the\n  candidate to retype what their own resume already says"
    );
  });
});
