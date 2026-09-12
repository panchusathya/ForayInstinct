/**
 * Playwright calls carry no timeout of their own unless one is passed, and a
 * CDP command to a browser that has stopped answering waits forever. Every
 * command the gateway runs outside the script race goes through here so a
 * silent upstream turns into a bounded answer, not a held socket.
 */
export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${String(ms)}ms`);
    this.name = "DeadlineError";
  }
}

export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineError(label, ms));
    }, ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
    // The loser of the race must not become an unowned rejection later.
    work.catch(() => undefined);
  }
}

/** The same race, resolving to `fallback` instead of throwing. */
export async function withDeadlineOr<T, F>(
  work: Promise<T>,
  ms: number,
  label: string,
  fallback: F
): Promise<T | F> {
  try {
    return await withDeadline(work, ms, label);
  } catch {
    return fallback;
  }
}
