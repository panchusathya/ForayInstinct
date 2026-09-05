/**
 * Where an application form actually lives, for the boards whose posting URL
 * is a description page with an Apply button one click away from it.
 *
 * Ashby's `jobs.ashbyhq.com/<org>/<id>` and Lever's `jobs.lever.co/<org>/<id>`
 * both describe the role; the form is at `/application` and `/apply`. Opened
 * at the description, the runner scanned a page with no fields, called the
 * form filled, and sent the description as the review. Anything not known
 * here is handled on the page itself by `reachApplicationFormCode`.
 */
export function applicationEntryUrl(applyUrl: string): string {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return applyUrl;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/u, "");
  const posting =
    /^\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  if (host === "jobs.ashbyhq.com" && posting.test(path)) {
    url.pathname = `${path}/application`;
    return url.toString();
  }
  if (host === "jobs.lever.co" && posting.test(path)) {
    url.pathname = `${path}/apply`;
    return url.toString();
  }
  return applyUrl;
}
