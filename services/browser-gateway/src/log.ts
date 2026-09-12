/**
 * One JSON line per event on stdout (stderr for failures), so Railway's log
 * view can be searched by event name. Until this existed the whole service
 * printed two lines in its life, and two days of a Workday run dying on its
 * first script were spent guessing from the client's side of the socket.
 *
 * Fields are plain values only: never a request body, a script, a cookie, or
 * a page's contents. A session id is fine; what the session was doing is not.
 */
export type LogFields = Record<string, boolean | number | string | undefined>;

export function log(event: string, fields: LogFields = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields, ts: new Date().toISOString() })}\n`);
}

export function logError(event: string, fields: LogFields = {}): void {
  process.stderr.write(`${JSON.stringify({ event, ...fields, ts: new Date().toISOString() })}\n`);
}

/** A short, stable reason for an error without its stack or any page text. */
export function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.slice(0, 200) ?? "unknown";
}

export function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack?.slice(0, 2_000) : undefined;
}
