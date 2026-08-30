import type { Attachment } from "chat";

export async function readLinqAttachment(attachment: Attachment) {
  if (attachment.data instanceof Buffer) {
    return {
      bytes: attachment.data,
      resolvedMimeType: attachment.mimeType ?? "",
    };
  }
  if (attachment.data instanceof Blob) {
    return {
      bytes: Buffer.from(await attachment.data.arrayBuffer()),
      resolvedMimeType: attachment.mimeType ?? attachment.data.type,
    };
  }
  if (attachment.fetchData) {
    return {
      bytes: await attachment.fetchData(),
      resolvedMimeType: attachment.mimeType ?? "",
    };
  }
  if (!attachment.url) throw new Error("the attachment has no download URL");

  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    resolvedMimeType: response.headers.get("content-type") ?? "",
  };
}

/** Retries the same already-downloaded attachment once before surfacing a save failure. */
export async function retryLinqResumeSave<T>(save: () => Promise<T>) {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await save();
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
