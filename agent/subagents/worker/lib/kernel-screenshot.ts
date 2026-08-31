import { z } from "zod";
import { maxApplicationReviewCaptures } from "@/lib/browser-submission";
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

/**
 * Marks the element a review capture scrolls. The tag lives in the page rather
 * than in Node, so the probe can hand the scroll calls a target across separate
 * Kernel executions without tracking frame identity.
 */
export const reviewScrollRootAttribute = "data-foray-review-root";

/** Sticky headers repaint and lazy sections render on scroll. */
const reviewScrollSettleMs = 400;

/** Slices overlap by a tenth so a field split by a boundary stays readable. */
const reviewCaptureOverlap = 0.9;

const reviewScrollRootSchema = z.object({
  clientHeight: z.number().positive(),
  maxScroll: z.number().nonnegative(),
  scrollTop: z.number().nonnegative(),
});
type ReviewScrollRoot = z.infer<typeof reviewScrollRootSchema>;

const reviewScrollResultSchema = z.object({ scrollTop: z.number() });

/**
 * `computer.captureScreenshot` photographs the display, so every scroll has to
 * drive the page that is actually on screen. Scrolling the newest page while a
 * different one is in front produces a run of identical screenshots.
 */
const frontPageCode = `
const pages = browser.contexts().flatMap((context) => context.pages());
let page = null;
for (const candidate of pages) {
  const visible = await candidate
    .evaluate(() => document.visibilityState === "visible")
    .catch(() => false);
  if (visible) page = candidate;
}
if (!page) {
  page = pages.at(-1) ?? null;
  if (page) await page.bringToFront().catch(() => undefined);
}`;

/**
 * Finds what actually scrolls. An ATS form is routinely not the document: a
 * Workday wizard scrolls an inner container and a Greenhouse or Lever embed
 * scrolls its iframe, so measuring `document.documentElement` reports nothing to
 * scroll and the review collapses to a single shot of wherever the worker
 * stopped, which is the submit control at the end of the form.
 */
export const reviewScrollRootProbeCode = `
${frontPageCode}
if (!page) return null;
const probe = (attribute) => {
  for (const stale of document.querySelectorAll("[" + attribute + "]")) {
    stale.removeAttribute(attribute);
  }
  const viewport = window.innerHeight || 0;
  const candidates = [document.scrollingElement, document.documentElement, document.body];
  let inspected = 0;
  for (const node of document.body ? document.body.querySelectorAll("*") : []) {
    // An ATS wizard is thousands of nodes and getComputedStyle is not free, so
    // reject on cheap geometry first and bound the walk.
    if (++inspected > 4000) break;
    if (node.scrollHeight - node.clientHeight < 100) continue;
    if (node.clientHeight < Math.min(300, viewport * 0.5)) continue;
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") candidates.push(node);
  }
  let best = null;
  for (const node of candidates) {
    if (!node) continue;
    const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
    if (!best || maxScroll > best.maxScroll) {
      best = {
        clientHeight: node.clientHeight || viewport,
        element: node,
        maxScroll,
        scrollTop: node.scrollTop || 0,
      };
    }
  }
  if (!best || best.maxScroll <= 0) return null;
  best.element.setAttribute(attribute, "1");
  return { clientHeight: best.clientHeight, maxScroll: best.maxScroll, scrollTop: best.scrollTop };
};
let found = null;
for (const frame of page.frames()) {
  const measured = await frame
    .evaluate(probe, ${JSON.stringify(reviewScrollRootAttribute)})
    .catch(() => null);
  if (measured && (!found || measured.maxScroll > found.maxScroll)) found = measured;
}
if (found) {
  // Each frame tagged its own best candidate. Keep only the winner so a scroll
  // cannot drag an unrelated sidebar in some other frame.
  for (const frame of page.frames()) {
    await frame.evaluate(({ attribute, maxScroll }) => {
      const root = document.querySelector("[" + attribute + "]");
      if (!root) return;
      if (Math.max(0, root.scrollHeight - root.clientHeight) !== maxScroll) {
        root.removeAttribute(attribute);
      }
    }, { attribute: ${JSON.stringify(reviewScrollRootAttribute)}, maxScroll: found.maxScroll }).catch(() => undefined);
  }
}
return found;`;

/** Scrolls the tagged root, settles the page, and reports where it landed. */
export function reviewScrollCode(top: number, clearRoot = false) {
  return `
const targetTop = ${JSON.stringify(Math.round(top))};
${frontPageCode}
if (!page) return { scrollTop: targetTop };
let reached = targetTop;
for (const frame of page.frames()) {
  const moved = await frame
    .evaluate(({ attribute, top }) => {
      const root = document.querySelector("[" + attribute + "]");
      if (!root) return null;
      if (typeof root.scrollTo === "function") root.scrollTo({ behavior: "instant", top });
      else root.scrollTop = top;
      return root.scrollTop;
    }, { attribute: ${JSON.stringify(reviewScrollRootAttribute)}, top: targetTop })
    .catch(() => null);
  if (typeof moved === "number") reached = moved;
}
await page.waitForTimeout(${JSON.stringify(reviewScrollSettleMs)});${
    clearRoot
      ? `
for (const frame of page.frames()) {
  await frame.evaluate((attribute) => {
    for (const tagged of document.querySelectorAll("[" + attribute + "]")) {
      tagged.removeAttribute(attribute);
    }
  }, ${JSON.stringify(reviewScrollRootAttribute)}).catch(() => undefined);
}`
      : ""
  }
return { scrollTop: reached };`;
}

/**
 * The candidate has to be able to read the whole form they are approving, and an
 * ATS review page is routinely several viewports tall. Slice it from the top
 * through the end with a little overlap, however many slices that takes up to
 * `maxApplicationReviewCaptures`, instead of photographing wherever the worker
 * happened to stop. Hold the vault mask across all captures: masking per capture
 * would unmask the page between shots and could expose an injected password in
 * the next one.
 */
export async function captureMaskedReviewScreenshots(
  sessionId: string,
  signal?: AbortSignal
) {
  const removeMask = await maskVaultFields(sessionId, signal);
  let root: ReviewScrollRoot | undefined;
  try {
    root = await detectReviewScrollRoot(sessionId, signal);
    if (!root) {
      // Nothing measurable to scroll: photograph the page where it stands
      // rather than moving one that could not be measured.
      const png = await captureKernelScreenshot(sessionId, signal);
      return png.byteLength > 0 ? [png] : [];
    }
    const captures: Buffer[] = [];
    let previousTop: number | undefined;
    for (const offset of reviewCaptureOffsets(root)) {
      const reached = await scrollReviewPageTo(sessionId, offset, signal);
      // A page that will not move further has nothing new to show, and a run of
      // identical images is worse than a short one.
      if (reached !== undefined && reached === previousTop) break;
      previousTop = reached;
      const png = await captureKernelScreenshot(sessionId, signal);
      if (png.byteLength === 0) continue;
      if (captures.at(-1)?.equals(png)) continue;
      captures.push(png);
    }
    return captures;
  } finally {
    // The worker resumes on this page to press submit, so put it back where it
    // was rather than leaving it scrolled to the end of the form.
    if (root) {
      await scrollReviewPageTo(sessionId, root.scrollTop, signal, true);
    }
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

async function detectReviewScrollRoot(
  sessionId: string,
  signal?: AbortSignal
): Promise<ReviewScrollRoot | undefined> {
  const response = await kernel.browsers.playwright
    .execute(
      sessionId,
      // The probe evaluates in every frame, so it gets more room than a scroll.
      { code: reviewScrollRootProbeCode, timeout_sec: 15 },
      { signal }
    )
    .catch(() => undefined);
  const parsed = reviewScrollRootSchema.safeParse(response?.result);
  if (!parsed.success || parsed.data.maxScroll === 0) return undefined;
  return parsed.data;
}

/**
 * Offsets from the top of the form through its end. Past the cap the slices are
 * spread evenly rather than truncated: the end of the form is what the candidate
 * is approving, so the last slice always has to be the bottom.
 */
function reviewCaptureOffsets(root: ReviewScrollRoot) {
  const step = Math.max(
    1,
    Math.round(root.clientHeight * reviewCaptureOverlap)
  );
  const needed = Math.ceil(root.maxScroll / step) + 1;
  const count = Math.min(Math.max(needed, 2), maxApplicationReviewCaptures);
  return Array.from({ length: count }, (_, index) =>
    Math.round((root.maxScroll * index) / (count - 1))
  ).filter(
    (offset, index, values) => index === 0 || offset !== values[index - 1]
  );
}

async function scrollReviewPageTo(
  sessionId: string,
  top: number,
  signal?: AbortSignal,
  clearRoot = false
) {
  const response = await kernel.browsers.playwright
    .execute(
      sessionId,
      { code: reviewScrollCode(top, clearRoot), timeout_sec: 10 },
      { signal }
    )
    .catch(() => undefined);
  const parsed = reviewScrollResultSchema.safeParse(response?.result);
  return parsed.success ? parsed.data.scrollTop : undefined;
}
