/**
 * Slices of one application's review page. The candidate approves what they can
 * read, so a tall ATS form is captured across several overlapping screenshots
 * rather than one shot of wherever the worker stopped.
 */
export const maxApplicationReviewCaptures = 6;

/**
 * One application's review slices plus the later `submitted` proof, which shares
 * the session's delivery batch. Keeping the claim limit above the capture cap is
 * what stops a slice from being stranded until the pending TTL retires it.
 */
export const maxClaimedSubmissionScreenshots = maxApplicationReviewCaptures + 1;

/**
 * Conservative evidence that an ATS already accepted an application. The
 * worker's Playwright return value is not a source of truth: it is often
 * `{ success: true }` with no page text, and a turn can end before
 * `final_output`. Classify from the confirmation URL only — posting-page copy
 * such as "we received your application" is not proof. The unused body
 * argument is kept so existing callers do not have to change.
 */
export function observedSubmission(
  url: string,
  _body?: string
): string | undefined {
  const location = browserPageLocation(url) ?? url;
  if (
    /applicationSubmitted/i.test(location) ||
    /\/confirmation(?:\/|$)/i.test(location)
  ) {
    return "application submitted";
  }
  return undefined;
}

/** Origin and pathname only, matching browser-run checkpoint `page` values. */
export function browserPageLocation(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function groupBrowserRunCheckpoints<
  T extends { page: string | null; sessionId: string },
>(rows: readonly T[]) {
  const order: string[] = [];
  const sessions = new Map<string, T[]>();
  for (const row of rows) {
    const existing = sessions.get(row.sessionId);
    if (existing) {
      existing.push(row);
      continue;
    }
    order.push(row.sessionId);
    sessions.set(row.sessionId, [row]);
  }
  return order.map((sessionId) => {
    const checkpoints = sessions.get(sessionId) ?? [];
    const pages = [
      ...new Set(checkpoints.flatMap((row) => (row.page ? [row.page] : []))),
    ];
    return { checkpoints, pages, sessionId };
  });
}
