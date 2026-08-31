/**
 * A Kernel live-view URL is an operator's window into the browser Foray is
 * driving. The candidate has no use for one: the review gate delivers pictures
 * of the form, and every other blocker is answered in the chat. The one
 * exception is a challenge only a person can complete in the page itself, which
 * the coordinator marks with `[[takeover]]`.
 */
const kernelHostPattern = /(^|\.)(onkernel\.com|kernel\.sh|kernel\.test)$/iu;
const urlPattern = /https?:\/\/[^\s<>()[\]]+/giu;
/** Nothing left but spacing, punctuation, or a lead-in the link used to follow. */
const strandedLinePattern = /^[\s\p{P}\p{S}]*$/u;

function isKernelLiveViewUrl(value: string) {
  try {
    return kernelHostPattern.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Removes Kernel live-view links from candidate-facing text. A line whose point
 * was the link goes with it: "you can watch it here" without the link reads as
 * an omission, and the candidate has nothing to do about it either way. Other
 * links are left alone, because an apply URL or a vault setup URL is theirs to
 * open.
 */
export function stripKernelLiveViewLinks(value: string) {
  if (!value.includes("http")) return value;
  const kept: string[] = [];
  for (const line of value.split("\n")) {
    const stripped = line.replace(urlPattern, (url) =>
      isKernelLiveViewUrl(url) ? "" : url
    );
    if (stripped === line) {
      kept.push(line);
      continue;
    }
    // Anything else on the line survives only alongside a link the candidate
    // can still act on.
    if (!/https?:\/\//iu.test(stripped)) continue;
    if (strandedLinePattern.test(stripped)) continue;
    kept.push(stripped.replace(/[ \t]{2,}/gu, " ").trim());
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
