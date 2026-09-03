/**
 * Bounds a best-effort step so it cannot hold the turn.
 *
 * The Linq webhook runs the candidate's whole turn inside one request. A read
 * receipt, a tapback, or an idle-session reset that never settles held that
 * request until Vercel killed the function at five minutes, and the message
 * was dropped with no reply and no retry. Each of these steps is already
 * optional; this makes their cost bounded as well.
 *
 * Resolves to `fallback` rather than throwing, because every caller here
 * treats a failure as "carry on" and a rejection would only be re-caught.
 * The losing promise is left to settle on its own: it has no further effect,
 * and attaching nothing to it would surface as an unhandled rejection.
 */
export async function withTimeout<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work().catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          resolve(fallback);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
