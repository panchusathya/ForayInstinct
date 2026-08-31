import { z } from "zod";
import { kernel } from "@/lib/kernel";
import {
  vaultScreenshotMaskCss,
  vaultScreenshotMaskStyleId,
} from "@/lib/vault-screenshot-mask";

type VaultMaskRemoval = (() => Promise<void>) & { readonly applied: boolean };

export async function maskVaultFields(
  sessionId: string,
  signal?: AbortSignal
): Promise<VaultMaskRemoval> {
  const addCode = `
for (const currentContext of browser.contexts()) {
  for (const currentPage of currentContext.pages()) {
    for (const frame of currentPage.frames()) {
      await frame.evaluate(({ styleId, css }) => {
        if (document.getElementById(styleId)) return;
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = css;
        document.documentElement.append(style);
      }, ${JSON.stringify({ css: vaultScreenshotMaskCss, styleId: vaultScreenshotMaskStyleId })}).catch(() => undefined);
    }
  }
}
return true;`;
  const response = await kernel.browsers.playwright
    .execute(sessionId, { code: addCode, timeout_sec: 10 }, { signal })
    .catch((error: unknown) => {
      console.warn("[vault-screenshot-mask] could not apply", {
        error: error instanceof Error ? error.message : "execution_failed",
        session_id: sessionId,
      });
      return undefined;
    });
  const applied = response?.success === true;
  if (!applied && response !== undefined) {
    console.warn("[vault-screenshot-mask] could not apply", {
      error: response.error ?? "execution_failed",
      session_id: sessionId,
    });
  }
  const remove = async () => {
    if (!applied) return;
    const removeCode = `
for (const currentContext of browser.contexts()) {
  for (const currentPage of currentContext.pages()) {
    for (const frame of currentPage.frames()) {
      await frame.evaluate((styleId) => document.getElementById(styleId)?.remove(), ${JSON.stringify(vaultScreenshotMaskStyleId)}).catch(() => undefined);
    }
  }
}
return true;`;
    await kernel.browsers.playwright
      .execute(sessionId, { code: removeCode, timeout_sec: 10 }, { signal })
      .catch(() => undefined);
  };
  return Object.assign(remove, { applied });
}

export async function captureMaskedKernelScreenshot(
  sessionId: string,
  signal?: AbortSignal
) {
  const removeMask = await maskVaultFields(sessionId, signal);
  try {
    return await captureKernelScreenshot(sessionId, signal);
  } finally {
    await removeMask();
  }
}

/** Enough slices for a long ATS review page without flooding a phone thread. */
const maxReviewCaptures = 3;

const reviewCaptureMetricsSchema = z.object({
  maxScroll: z.number().nonnegative(),
});

/**
 * The candidate has to be able to read the whole form they are approving, and
 * an ATS review page is routinely taller than the viewport. Capture the page in
 * top, middle, and bottom of the review page. This captures the full shape of
 * a normal ATS form instead of starting wherever the worker happened to stop.
 * Hold the vault mask across all captures: masking per capture would unmask
 * the page between shots and could expose an injected password in the next one.
 */
export async function captureMaskedReviewScreenshots(
  sessionId: string,
  signal?: AbortSignal
) {
  const removeMask = await maskVaultFields(sessionId, signal);
  try {
    const captures: Buffer[] = [];
    for (const offset of await reviewCaptureOffsets(sessionId, signal)) {
      await scrollReviewPageTo(sessionId, offset, signal);
      const png = await captureKernelScreenshot(sessionId, signal);
      if (png.byteLength > 0) captures.push(png);
    }
    return captures;
  } finally {
    // The worker resumes on this page to press submit, so leave it where it
    // was rather than scrolled to the bottom of the form.
    await scrollReviewPageToTop(sessionId, signal);
    await removeMask();
  }
}

async function captureKernelScreenshot(
  sessionId: string,
  signal?: AbortSignal
) {
  const response = await kernel.browsers.computer.captureScreenshot(
    sessionId,
    {},
    { signal }
  );
  return Buffer.from(await response.arrayBuffer());
}

/** Space at most three review images from the beginning through the end. */
async function reviewCaptureOffsets(sessionId: string, signal?: AbortSignal) {
  const code = `
const page = browser.contexts().flatMap((context) => context.pages()).at(-1);
if (!page) return { maxScroll: 0 };
return await page.evaluate(() => {
  return {
    maxScroll: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  };
});`;
  const response = await kernel.browsers.playwright
    .execute(sessionId, { code, timeout_sec: 10 }, { signal })
    .catch(() => undefined);
  const parsed = reviewCaptureMetricsSchema.safeParse(response?.result);
  if (!parsed.success || parsed.data.maxScroll === 0) return [0];
  const offsets = [0, parsed.data.maxScroll / 2, parsed.data.maxScroll]
    .map((offset) => Math.round(offset))
    .filter(
      (offset, index, values) => index === 0 || offset !== values[index - 1]
    );
  return offsets.slice(0, maxReviewCaptures);
}

async function scrollReviewPageTo(
  sessionId: string,
  top: number,
  signal?: AbortSignal
) {
  const code = `
const page = browser.contexts().flatMap((context) => context.pages()).at(-1);
if (!page) return true;
await page
  .evaluate((top) => window.scrollTo({ behavior: "instant", top }), ${JSON.stringify(top)})
  .catch(() => undefined);
return true;`;
  await kernel.browsers.playwright
    .execute(sessionId, { code, timeout_sec: 10 }, { signal })
    .catch(() => undefined);
}

async function scrollReviewPageToTop(sessionId: string, signal?: AbortSignal) {
  await scrollReviewPageTo(sessionId, 0, signal);
}
