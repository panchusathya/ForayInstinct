import type { Page } from "playwright-core";
// @boundaries-ignore shared wire contract lives in the app package (lib/browser/contract.ts)
import type { ScreenshotRequest } from "../../../lib/browser/contract.ts";

/** Marks the element review slices scroll, mirroring the Kernel-era capture. */
const scrollRootAttribute = "data-foray-review-root";

/** Sticky headers repaint and lazy sections render on scroll. */
const scrollSettleMs = 400;

/** Slices overlap by a tenth so a field split by a boundary stays readable. */
const sliceOverlap = 0.9;

const defaultMaxSlices = 3;

/** Chromium refuses absurdly tall full-page captures; slice instead. */
const fullPageHeightLimit = 16_000;

const defaultMaskStyleId = "foray-gateway-screenshot-mask";

export interface ScrollRoot {
  clientHeight: number;
  maxScroll: number;
  scrollTop: number;
}

/**
 * Offsets from the top of the scroll root through its end. Past the cap the
 * slices are spread evenly rather than truncated: the end of the form is what
 * the reader is approving, so the last slice is always the bottom.
 */
export function computeSliceOffsets(
  root: Pick<ScrollRoot, "clientHeight" | "maxScroll">,
  maxSlices: number
): number[] {
  if (root.maxScroll <= 0) return [0];
  const step = Math.max(1, Math.round(root.clientHeight * sliceOverlap));
  const needed = Math.ceil(root.maxScroll / step) + 1;
  const count = Math.min(Math.max(needed, 2), Math.max(maxSlices, 1));
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, index) =>
    Math.round((root.maxScroll * index) / (count - 1))
  ).filter(
    (offset, index, values) => index === 0 || offset !== values[index - 1]
  );
}

export async function applyMask(
  page: Page,
  css: string,
  styleId: string
): Promise<void> {
  for (const frame of page.frames()) {
    await frame
      .evaluate(
        ({ css, styleId }) => {
          if (document.getElementById(styleId)) return;
          const style = document.createElement("style");
          style.id = styleId;
          style.textContent = css;
          document.documentElement.append(style);
        },
        { css, styleId }
      )
      .catch(() => undefined);
  }
}

export async function removeMask(page: Page, styleId: string): Promise<void> {
  for (const frame of page.frames()) {
    await frame
      .evaluate(
        (styleId) => document.getElementById(styleId)?.remove(),
        styleId
      )
      .catch(() => undefined);
  }
}

/**
 * Holds the mask for the duration of `capture`. Masking per shot would unmask
 * the page between shots and could expose an injected secret in the next one.
 */
export async function withScreenshotMask<T>(
  page: Page,
  maskCss: string | undefined,
  maskStyleId: string | undefined,
  capture: () => Promise<T>
): Promise<T> {
  if (!maskCss) return capture();
  const styleId = maskStyleId ?? defaultMaskStyleId;
  await applyMask(page, maskCss, styleId);
  try {
    return await capture();
  } finally {
    await removeMask(page, styleId);
  }
}

/**
 * Finds what actually scrolls. An ATS form is routinely not the document: a
 * Workday wizard scrolls an inner container and a Greenhouse or Lever embed
 * scrolls its iframe, so measuring `document.documentElement` reports nothing
 * to scroll and the review would collapse to a single shot.
 */
async function detectScrollRoot(page: Page): Promise<ScrollRoot | undefined> {
  const probe = (attribute: string) => {
    for (const stale of document.querySelectorAll(`[${attribute}]`)) {
      stale.removeAttribute(attribute);
    }
    const viewport = window.innerHeight || 0;
    const candidates: Element[] = [];
    for (const node of [
      document.scrollingElement,
      document.documentElement,
      document.body,
    ]) {
      if (node) candidates.push(node);
    }
    // An ATS wizard is thousands of nodes and getComputedStyle is not free, so
    // reject on cheap geometry first and bound the walk.
    let inspected = 0;
    for (const node of Array.from(document.querySelectorAll("body *"))) {
      if (++inspected > 4_000) break;
      if (node.scrollHeight - node.clientHeight < 100) continue;
      if (node.clientHeight < Math.min(300, viewport * 0.5)) continue;
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === "auto" || overflow === "scroll") candidates.push(node);
    }
    let best: {
      clientHeight: number;
      element: Element;
      maxScroll: number;
      scrollTop: number;
    } | null = null;
    for (const node of candidates) {
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
    return {
      clientHeight: best.clientHeight,
      maxScroll: best.maxScroll,
      scrollTop: best.scrollTop,
    };
  };
  let found: ScrollRoot | null = null;
  for (const frame of page.frames()) {
    const measured = await frame
      .evaluate(probe, scrollRootAttribute)
      .catch(() => null);
    if (measured && (!found || measured.maxScroll > found.maxScroll)) {
      found = measured;
    }
  }
  if (found) {
    // Each frame tagged its own best candidate. Keep only the winner so a
    // scroll cannot drag an unrelated sidebar in some other frame.
    const winner = found;
    for (const frame of page.frames()) {
      await frame
        .evaluate(
          ({ attribute, maxScroll }) => {
            const root = document.querySelector(`[${attribute}]`);
            if (!root) return;
            if (
              Math.max(0, root.scrollHeight - root.clientHeight) !== maxScroll
            ) {
              root.removeAttribute(attribute);
            }
          },
          { attribute: scrollRootAttribute, maxScroll: winner.maxScroll }
        )
        .catch(() => undefined);
    }
  }
  return found ?? undefined;
}

/** Scrolls the tagged root, settles the page, and reports where it landed. */
async function scrollRootTo(
  page: Page,
  top: number
): Promise<number | undefined> {
  let reached: number | undefined;
  for (const frame of page.frames()) {
    const moved = await frame
      .evaluate(
        ({ attribute, top }) => {
          const root = document.querySelector(`[${attribute}]`);
          if (!root) return null;
          if (typeof root.scrollTo === "function") {
            root.scrollTo({ behavior: "instant", top });
          } else {
            root.scrollTop = top;
          }
          return root.scrollTop;
        },
        { attribute: scrollRootAttribute, top: Math.round(top) }
      )
      .catch(() => null);
    if (typeof moved === "number") reached = moved;
  }
  await page.waitForTimeout(scrollSettleMs);
  return reached;
}

async function clearScrollRoot(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    await frame
      .evaluate((attribute) => {
        for (const tagged of document.querySelectorAll(`[${attribute}]`)) {
          tagged.removeAttribute(attribute);
        }
      }, scrollRootAttribute)
      .catch(() => undefined);
  }
}

async function captureReviewSlices(
  page: Page,
  maxSlices: number
): Promise<Buffer[]> {
  const root = await detectScrollRoot(page);
  if (!root) {
    // Nothing measurable to scroll: photograph the page where it stands.
    const png = await page.screenshot();
    return png.byteLength > 0 ? [png] : [];
  }
  const captures: Buffer[] = [];
  try {
    let previousTop: number | undefined;
    for (const offset of computeSliceOffsets(root, maxSlices)) {
      const reached = await scrollRootTo(page, offset);
      // A page that will not move further has nothing new to show, and a run
      // of identical images is worse than a short one.
      if (reached !== undefined && reached === previousTop) break;
      previousTop = reached;
      const png = await page.screenshot();
      if (png.byteLength === 0) continue;
      if (captures.at(-1)?.equals(png)) continue;
      captures.push(png);
    }
    return captures;
  } finally {
    // The caller resumes on this page, so put it back where it was rather
    // than leaving it scrolled to the end of the form.
    await scrollRootTo(page, root.scrollTop).catch(() => undefined);
    await clearScrollRoot(page);
  }
}

export async function captureScreenshots(
  page: Page,
  request: ScreenshotRequest
): Promise<string[]> {
  const maxSlices = request.max_slices ?? defaultMaxSlices;
  return withScreenshotMask(
    page,
    request.mask_css,
    request.mask_style_id,
    async () => {
      if (request.mode === "viewport") {
        return [(await page.screenshot({ quality: 45, type: "jpeg" })).toString("base64")];
      }
      if (request.mode === "full_page") {
        const scrollHeight = await page
          .evaluate(
            () =>
              (document.scrollingElement ?? document.documentElement)
                .scrollHeight
          )
          .catch(() => 0);
        if (scrollHeight <= fullPageHeightLimit) {
          try {
            const png = await page.screenshot({ fullPage: true });
            return [png.toString("base64")];
          } catch {
            // Chromium can refuse very tall or busy pages; fall back to slices.
          }
        }
      }
      const slices = await captureReviewSlices(page, maxSlices);
      return slices.map((png) => png.toString("base64"));
    }
  );
}
