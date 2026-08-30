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
  if (/successfully submitted/i.test(text)) return "successfully submitted";
  if (/we have received/i.test(text)) return "we have received";
  if (/application[\s\S]{0,40}(?:received|submitted)/i.test(text)) {
    return "application received";
  }
  if (
    /thank you[\s\S]{0,80}(?:for (?:your )?(?:application|applying)|application)/i.test(
      text
    ) ||
    /(?:application|applying)[\s\S]{0,80}thank you/i.test(text)
  ) {
    return "thank you";
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
