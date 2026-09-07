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

/** A confirmation address: the ATS moved to a page named for the submission. */
export const submissionUrlPattern =
  /applicationSubmitted|\/confirmation(?:\/|$)/iu;

/**
 * Confirmation copy an ATS renders on the page it leaves the candidate on.
 * Greenhouse, Lever and Ashby confirm this way, on the same address the form
 * had. It is evidence only right after a submit click, and only when the same
 * words were not already on the page before it: a posting's own "once your
 * application has been submitted" must never count.
 */
export const submissionConfirmationText =
  /thank you for applying|application (?:has been |was )?(?:submitted|received)|we(?:'ve| have) received your application|successfully submitted/iu;

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
  return submissionUrlPattern.test(location)
    ? "application submitted"
    : undefined;
}

/**
 * What an image's own bytes say it is. The gateway's viewport screenshots are
 * JPEG while the sliced ones are PNG, and a row stamped with the wrong type
 * reaches the channel as a picture that will not open.
 */
export function imageMimeType(bytes: Uint8Array): "image/jpeg" | "image/png" {
  return bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png";
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
