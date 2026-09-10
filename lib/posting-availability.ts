/**
 * Whether a page says the posting it was asked for cannot be applied to.
 *
 * Two shapes of one fact, and an ATS uses both. A deleted posting keeps its
 * URL resolvable and answers with "Job not found"; a closed one stays fully
 * rendered with a notice where the form used to be. Either way the page has
 * nothing to fill, which the runner used to report as a posting with no Apply
 * control — a technical fault the candidate was asked to work around rather
 * than a role that is gone.
 *
 * Owned here because two callers need the same wording, from opposite ends of
 * the same problem: role search rejects such a hit before it becomes a card,
 * and the runner pauses on it as `posting_unavailable`.
 */

/**
 * Phrases an ATS leaves on a role it has closed. Greenhouse and Lever keep the
 * URL resolvable after a takedown, so the URL shape and the title still look
 * exactly like an open posting and every check downstream passes. The body is
 * the only signal that survives it.
 */
const CLOSED_POSTING_RE =
  /\b(?:no longer (?:accepting|accepts|being accepted|available|open)|not (?:currently )?accepting applications|this (?:job|position|posting|role|opening|requisition) (?:is|has been) (?:closed|filled|expired|removed)|position has been filled|posting has (?:expired|been closed)|applications? (?:are|is) (?:now )?closed)\b/iu;

/**
 * Phrases an ATS leaves where a posting has been deleted outright. Kept
 * separate from the closed wording, and deliberately anchored on the noun: a
 * bare "not found" appears in plenty of live job descriptions, and role search
 * runs its check over a whole page of scraped text.
 */
const MISSING_POSTING_RE =
  /\b(?:job|position|posting|role|opening|requisition)\s+not\s+found\b|\bthe\s+(?:job|position|posting|role|opening)\s+you\s+(?:requested|asked\s+for|are\s+looking\s+for)\s+(?:was|is|could)\s+not\s+(?:be\s+)?found\b/iu;

/**
 * The role is not there to apply to, whichever way the page says so. One
 * question, because no caller has ever needed to tell a closed posting from a
 * deleted one: both mean the same thing to the candidate.
 */
export function isUnavailablePostingText(text: string) {
  return CLOSED_POSTING_RE.test(text) || MISSING_POSTING_RE.test(text);
}
