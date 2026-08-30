import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentParts } from "@/app/_lib/attachment-parts";

const pdfBytes = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
]);

function dataUrl(mediaType: string, bytes: Uint8Array) {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

describe("composer attachments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends bytes, never a URL, so eve can stage the file", async () => {
    const [part] = await attachmentParts([
      {
        filename: "offer.pdf",
        mediaType: "application/pdf",
        url: dataUrl("application/pdf", pdfBytes),
      },
    ]);

    // A URL left in `data` is passed straight to the provider, and every GLM
    // provider rejects a PDF file part carrying one.
    expect(part?.data).toBeInstanceOf(Uint8Array);
    expect(typeof part?.data).not.toBe("string");
    expect(part?.data).toEqual(pdfBytes);
    expect(part).toMatchObject({
      filename: "offer.pdf",
      mediaType: "application/pdf",
      type: "file",
    });
  });

  it("gives a typeless attachment a concrete media type", async () => {
    const [part] = await attachmentParts([
      { filename: "notes", mediaType: "", url: dataUrl("", pdfBytes) },
    ]);

    expect(part?.mediaType).toBe("application/octet-stream");
  });

  it("reports an unreadable attachment instead of sending a broken part", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(null, { status: 404 }))
    );

    await expect(
      attachmentParts([
        { filename: "gone.png", url: "https://example.com/gone.png" },
      ])
    ).rejects.toThrow("Unable to read the attached file.");
  });
});
