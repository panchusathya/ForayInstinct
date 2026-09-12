import { withDeadlineOr } from "./deadline.ts";

/** The slice of a Playwright Page this module needs; small enough to fake. */
export interface VisibilityPage {
  evaluate(fn: () => boolean): Promise<boolean>;
}

/**
 * How long one visibility probe may take before the page is treated as not
 * visible. This runs before every script, action, screenshot and CDP call;
 * a page mid-navigation on a protected site can hold `evaluate` for as long
 * as the unlock takes, and the request it fronts has a far shorter budget.
 */
export const visibilityProbeMs = 3_000;

/**
 * The page the user would see: the visible one, else the most recent. Never
 * throws and never waits longer than the probe budget per page.
 */
export async function pickCurrentPage<P extends VisibilityPage>(
  pages: readonly P[],
  probeMs = visibilityProbeMs
): Promise<P | undefined> {
  let visible: P | undefined;
  for (const candidate of pages) {
    const isVisible = await withDeadlineOr(
      candidate
        .evaluate(() => document.visibilityState === "visible")
        .catch(() => false),
      probeMs,
      "page visibility probe",
      false
    );
    if (isVisible) visible = candidate;
  }
  return visible ?? pages.at(-1);
}
