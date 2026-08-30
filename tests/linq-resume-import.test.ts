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

  it("retries the same document save once", async () => {
    const save = vi
      .fn<() => Promise<{ filename: string }>>()
      .mockRejectedValueOnce(new Error("temporary database failure"))
      .mockResolvedValueOnce({ filename: "resume.pdf" });

    await expect(retryLinqResumeSave(save)).resolves.toEqual({
      filename: "resume.pdf",
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

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
