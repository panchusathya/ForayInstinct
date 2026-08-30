/**
 * Conservative evidence that an ATS already accepted an application. The
 * worker's Playwright return value is not a source of truth: it is often
 * `{ success: true }` with no page text, and a turn can end before
 * `final_output`. Classify from the live page instead, and never persist the
 * body snippet.
 */
export function observedSubmission(
  url: string,
  body: string
): string | undefined {
  const location = browserPageLocation(url) ?? url;
  if (
    /applicationSubmitted/i.test(location) ||
    /\/confirmation(?:\/|$)/i.test(location)
  ) {
    return "application submitted";
  }

  const text = body.replace(/\s+/g, " ");
  if (
    /application[\s\S]{0,80}successfully submitted/i.test(text) ||
    /successfully submitted[\s\S]{0,80}application/i.test(text)
  ) {
    return "successfully submitted";
  }
  if (
    /application[\s\S]{0,80}(?:successfully )?(?:received|submitted)/i.test(
      text
    ) ||
    /(?:successfully )?(?:received|submitted)[\s\S]{0,80}application/i.test(
      text
    )
  ) {
    return "application received";
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
