import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeLinqDocument,
  readLinqAttachment,
  retryLinqResumeSave,
} from "@/lib/linq-resume-import";

describe("Linq resume import", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the channel attachment reader before a raw download URL", async () => {
    const fetchData = vi
      .fn<() => Promise<Buffer>>()
      .mockResolvedValue(Buffer.from("resume bytes"));
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);

    await expect(
      readLinqAttachment({
        fetchData,
        mimeType: "application/pdf",
        type: "file",
        url: "https://example.com/resume.pdf",
      })
    ).resolves.toEqual({
      bytes: Buffer.from("resume bytes"),
      resolvedMimeType: "application/pdf",
    });

    expect(fetchData).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries the same document save once after a transient database fault", async () => {
    const save = vi
      .fn<() => Promise<{ filename: string }>>()
      // 57P01: the server terminated the connection. Class 57 is transient.
      .mockRejectedValueOnce(sqlError("57P01"))
      .mockResolvedValueOnce({ filename: "resume.pdf" });

    await expect(retryLinqResumeSave(save)).resolves.toEqual({
      filename: "resume.pdf",
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("retries a socket fault raised without a SQLSTATE", async () => {
    const save = vi
      .fn<() => Promise<{ filename: string }>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
      )
      .mockResolvedValueOnce({ filename: "resume.pdf" });

    await expect(retryLinqResumeSave(save)).resolves.toEqual({
      filename: "resume.pdf",
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("does not retry a statement the database rejected on its merits", async () => {
    // 22021 is the rejection that lost iMessage resumes: a NUL in a text
    // column. The same bytes produce it every time.
    const save = vi
      .fn<() => Promise<{ filename: string }>>()
      .mockRejectedValue(
        Object.assign(new Error("Failed query"), { cause: sqlError("22021") })
      );

    await expect(retryLinqResumeSave(save)).rejects.toThrow("Failed query");
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not spend the retry on a rejection the same bytes will repeat", async () => {
    const save = vi
      .fn<() => Promise<{ filename: string }>>()
      .mockRejectedValue(new Error("Upload a file smaller than 8 MB."));

    await expect(retryLinqResumeSave(save)).rejects.toThrow(
      "Upload a file smaller than 8 MB."
    );
    expect(save).toHaveBeenCalledOnce();
  });

  function sqlError(code: string) {
    return Object.assign(new Error(`database rejected the statement`), {
      code,
    });
  }

  it("recognizes a PDF when Linq provides only generic file metadata", () => {
    expect(
      normalizeLinqDocument({
        bytes: Buffer.from("%PDF-1.7\nresume"),
        filename: "upload",
        mimeType: "application/octet-stream",
      })
    ).toEqual({ filename: "upload.pdf", mimeType: "application/pdf" });
  });
});
