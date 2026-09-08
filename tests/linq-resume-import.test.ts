import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAllowedLinqAttachmentUrl,
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

  it("downloads only from Linq's own media host", async () => {
    // The URL comes from the webhook body; fetching whatever it named made the
    // webhook a way to have this server reach arbitrary addresses.
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    await expect(
      readLinqAttachment({
        mimeType: "application/pdf",
        type: "file",
        url: "https://evil.example/resume.pdf",
      })
    ).rejects.toThrow(/not hosted by Linq/u);
    expect(fetch).not.toHaveBeenCalled();
    expect(isAllowedLinqAttachmentUrl("https://cdn.linqapp.com/a/b.pdf")).toBe(
      true
    );
    expect(
      isAllowedLinqAttachmentUrl("https://media.cdn.linqapp.com/a.pdf")
    ).toBe(true);
    expect(isAllowedLinqAttachmentUrl("http://cdn.linqapp.com/a.pdf")).toBe(
      false
    );
    expect(
      isAllowedLinqAttachmentUrl("https://cdn.linqapp.com.evil.example/a.pdf")
    ).toBe(false);
    expect(
      isAllowedLinqAttachmentUrl("https://files.sandbox.test/a.pdf", [
        "files.sandbox.test",
      ])
    ).toBe(true);
  });

  it("bounds the download and never follows a redirect", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(Buffer.from("%PDF-1.4"), {
        headers: { "content-type": "application/pdf" },
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      readLinqAttachment({
        type: "file",
        url: "https://cdn.linqapp.com/a/resume.pdf",
      })
    ).resolves.toMatchObject({ resolvedMimeType: "application/pdf" });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
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
