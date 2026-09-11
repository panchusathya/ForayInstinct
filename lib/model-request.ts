import type { LanguageModelMiddleware } from "ai";

/**
 * Per-call generation caps and prompt trimming. Eve's session token limits are
 * lifetime budgets and do not set maxOutputTokens, so Qwen VL otherwise
 * reserves its 65,536 default and blows the 131k window.
 *
 * The cap exists to stop that reservation, not to keep answers short, and at
 * 1,000 it had become the second. A pause carrying several questions with the
 * page's own choices beside each one, an unmapped-fill helper answering in
 * JSON for a long form, and any turn that must both write to the candidate and
 * call a tool all ran into it; a generation stopped at the ceiling is a
 * truncated tool call, which is a turn that never lands. Against the 120k
 * window the agent declares, 4,000 is three per cent reserved, which buys the
 * room back for a rounding error.
 */
export const COORDINATOR_MAX_OUTPUT_TOKENS = 4_000;
export const WORKER_MAX_OUTPUT_TOKENS = 4_000;

export function capMaxOutputTokens<T extends { maxOutputTokens?: number }>(
  params: T,
  cap: number
): T & { maxOutputTokens: number } {
  return {
    ...params,
    maxOutputTokens: Math.min(params.maxOutputTokens ?? cap, cap),
  };
}

function isPromptImagePart(part: unknown) {
  if (!part || typeof part !== "object") return false;
  const type = "type" in part ? part.type : undefined;
  if (type === "image") return true;
  if (type !== "file") return false;
  const mediaType =
    "mediaType" in part && typeof part.mediaType === "string"
      ? part.mediaType
      : "";
  return mediaType.startsWith("image/");
}

export function keepLastPromptImage<T>(prompt: T): T {
  const clone = structuredClone(prompt);
  const images: { index: number; parent: unknown[] }[] = [];
  collectPromptImages(clone, images);
  for (const found of images.slice(0, -1).toReversed()) {
    found.parent.splice(found.index, 1);
  }
  return clone;
}

function collectPromptImages(
  value: unknown,
  images: { index: number; parent: unknown[] }[]
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (isPromptImagePart(item)) {
        images.push({ index, parent: value });
        return;
      }
      collectPromptImages(item, images);
    });
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      collectPromptImages(nested, images);
    }
  }
}

export function forceMaxOutputTokensMiddleware(
  cap: number
): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => capMaxOutputTokens(params, cap),
  };
}

export function keepLastPromptImageMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => ({
      ...params,
      prompt: keepLastPromptImage(params.prompt),
    }),
  };
}
