import { z } from "zod";
import { kernel } from "@/lib/kernel";

export async function maskVaultFields(sessionId: string, signal?: AbortSignal) {
  const styleId = "vault-screenshot-mask";
  const selector = '[data-vault-secret="true"]';
  const addCode = `
for (const currentContext of browser.contexts()) {
  for (const currentPage of currentContext.pages()) {
    for (const frame of currentPage.frames()) {
      await frame.evaluate(({ styleId, selector }) => {
        if (document.getElementById(styleId)) return;
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = selector + " { color: transparent !important; text-shadow: 0 0 8px black !important; -webkit-text-security: disc !important; }";
        document.documentElement.append(style);
      }, ${JSON.stringify({ selector, styleId })}).catch(() => undefined);
    }
  }
}
return true;`;
  await kernel.browsers.playwright.execute(
    sessionId,
    { code: addCode, timeout_sec: 10 },
    { signal }
  );
  return async () => {
    const removeCode = `
for (const currentContext of browser.contexts()) {
  for (const currentPage of currentContext.pages()) {
    for (const frame of currentPage.frames()) {
      await frame.evaluate((styleId) => document.getElementById(styleId)?.remove(), ${JSON.stringify(styleId)}).catch(() => undefined);
    }
  }
}
return true;`;
    await kernel.browsers.playwright
      .execute(sessionId, { code: removeCode, timeout_sec: 10 }, { signal })
      .catch(() => undefined);
  };
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

const reviewScrollResultSchema = z.object({ atBottom: z.boolean() });

/**
 * The candidate has to be able to read the whole form they are approving, and
 * an ATS review page is routinely taller than the viewport. Capture the page in
 * successive viewport-height slices instead of one cropped shot, and hold the
 * vault mask across all of them: masking per capture would unmask the page
 * between shots and could expose an injected password in the next one.
 */
export async function captureMaskedReviewScreenshots(
  sessionId: string,
  signal?: AbortSignal
) {
  const removeMask = await maskVaultFields(sessionId, signal);
  try {
    const captures: Buffer[] = [];
    for (let capture = 0; capture < maxReviewCaptures; capture += 1) {
      const png = await captureKernelScreenshot(sessionId, signal);
      if (png.byteLength > 0) captures.push(png);
      if (await scrolledToReviewBottom(sessionId, signal)) break;
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

/** Advances one viewport and reports whether the page has nothing left below. */
async function scrolledToReviewBottom(sessionId: string, signal?: AbortSignal) {
  const code = `
const page = browser.contexts().flatMap((context) => context.pages()).at(-1);
if (!page) return { atBottom: true };
return await page.evaluate(() => {
  const before = window.scrollY;
  window.scrollTo({ behavior: "instant", top: before + window.innerHeight });
  return {
    atBottom:
      window.scrollY <= before ||
      window.scrollY + window.innerHeight >=
        document.documentElement.scrollHeight - 1,
  };
});`;
  const response = await kernel.browsers.playwright
    .execute(sessionId, { code, timeout_sec: 10 }, { signal })
    .catch(() => undefined);
  const parsed = reviewScrollResultSchema.safeParse(response?.result);
  // A page that will not report its own scroll state is not worth re-shooting.
  return parsed.success ? parsed.data.atBottom : true;
}

async function scrollReviewPageToTop(sessionId: string, signal?: AbortSignal) {
  const code = `
const page = browser.contexts().flatMap((context) => context.pages()).at(-1);
if (!page) return true;
await page
  .evaluate(() => window.scrollTo({ behavior: "instant", top: 0 }))
  .catch(() => undefined);
return true;`;
  await kernel.browsers.playwright
    .execute(sessionId, { code, timeout_sec: 10 }, { signal })
    .catch(() => undefined);
}
