import {
  readCandidateProfile,
  saveCandidateProfile,
} from "@/db/services/candidate-profile";
import { readOrImportDefaultResume } from "@/db/services/default-resume";
import type { AccessScope } from "@/lib/access-scope";
import { applicationExecutionLog } from "@/lib/application-execution";
import {
  type CandidateProfile,
  type CandidateProfilePatch,
  missingProfileFields,
} from "@/lib/candidate-profile";
import {
  contactFactsPatch,
  extractProfileFromResume,
  type ResumeSource,
  resumeText,
} from "@/lib/resume-profile";
import { applicationPauseMessage } from "@/lib/task-completion";

/**
 * The blocking facts a run would have to interrogate the candidate for.
 *
 * Deliberately the same `missingProfileFields` the `candidate_profile` tool
 * reports, so the agent can never satisfy the list it was given and still be
 * refused, or be refused for something it was never told to ask about.
 *
 * Fails open in both directions. The gate exists to skip a run that cannot
 * succeed, not to invent a refusal when a dependency is down: a resume lookup
 * that throws counts as a resume on file, and an unreadable profile starts the
 * application exactly as it would have before this check existed.
 */
export async function missingProfileFacts(
  scope: AccessScope
): Promise<string[]> {
  try {
    const [stored, resume] = await Promise.all([
      readCandidateProfile(scope),
      // The same call the fill makes to stage the file, so this warms the local
      // copy rather than costing a round trip. `hasDefaultResume` would only
      // see the local table and would tell a candidate whose resume lives in
      // JuiceBox to type their legal name into chat.
      readOrImportDefaultResume(scope).then(
        (document) => ({ document, reachable: true }),
        // A lookup that throws still counts as a resume on file. The gate
        // exists to skip a doomed run, not to add a refusal when JuiceBox is
        // down.
        () => ({ document: undefined, reachable: false })
      ),
    ]);
    const profile = await adoptResumeFacts(scope, stored, resume.document);
    return missingProfileFields(profile, {
      hasResume: !resume.reachable || resume.document !== undefined,
    });
  } catch {
    return [];
  }
}

/**
 * Reads the resume into the profile the first time a fill needs it.
 *
 * A resume covers a candidate's name and history, but only as a file: the
 * runner needs those as strings to type into inputs. Without this the resume
 * suppressed the questions at intake and then could not answer them at the
 * form, so the candidate was asked for their own name field by field.
 *
 * Two reads, priced differently. The contact facts — an email address, a
 * LinkedIn URL — are regexes over the stored text and run whenever either is
 * missing. The model read, for names and history, runs only while one of
 * those is missing, because a resume that lacks a city would otherwise cost a
 * model call on every start with nothing to show for it. Neither overwrites a
 * value already on the profile, and anything that goes wrong returns the
 * stored profile untouched — a model call must not decide whether an
 * application can start.
 */
async function adoptResumeFacts(
  scope: AccessScope,
  stored: CandidateProfile,
  resume: ResumeSource | undefined
) {
  if (!resume) return stored;
  const wantsContact =
    stored.contactEmail === "" ||
    !stored.links.some((link) => /linkedin/iu.test(link.label + link.url));
  const wantsModel =
    stored.legalFirstName === "" ||
    stored.legalLastName === "" ||
    stored.workHistory.length === 0;
  if (!wantsContact && !wantsModel) return stored;
  try {
    const text = resumeText(resume);
    if (text === "") {
      applicationExecutionLog({
        event: "runner.resume_profile",
        extracted: "no text",
        stored: "none",
      });
      return stored;
    }
    const extracted = wantsModel
      ? await extractProfileFromResume({ extractedText: text })
      : contactFactsPatch(text);
    const patch = extracted ? onlyUnset(stored, extracted) : {};
    // Field names only, never their values. Without this there is no way to
    // tell a model that failed from a resume that said nothing from a patch
    // correctly skipped because the candidate had already answered.
    applicationExecutionLog({
      event: "runner.resume_profile",
      extracted: extracted ? Object.keys(extracted).join(", ") : "none",
      read: wantsModel ? "model" : "regex",
      stored: Object.keys(patch).join(", ") || "none",
    });
    if (Object.keys(patch).length === 0) return stored;
    const saved = await saveCandidateProfile(scope, patch);
    return saved.profile;
  } catch (error) {
    applicationExecutionLog({
      error: error instanceof Error ? error.message : "unknown",
      event: "runner.resume_profile_failed",
    });
    return stored;
  }
}

/**
 * The candidate's own entries always win over anything read off a resume.
 * Links are the one list that merges: a LinkedIn URL found on the resume joins
 * the links the candidate typed rather than being dropped because they typed
 * any at all.
 */
function onlyUnset(stored: CandidateProfile, patch: CandidateProfilePatch) {
  const current: Record<string, unknown> = { ...stored };
  const kept: Record<string, unknown> = {};
  const { links, ...rest } = patch;
  if (links) {
    const known = new Set(stored.links.map((link) => link.url.toLowerCase()));
    const added = links.filter((link) => !known.has(link.url.toLowerCase()));
    if (added.length > 0) kept.links = [...stored.links, ...added];
  }
  for (const [key, value] of Object.entries(rest)) {
    const existing = current[key];
    const alreadySet = Array.isArray(existing)
      ? existing.length > 0
      : typeof existing === "string"
        ? existing.trim() !== ""
        : existing !== null && existing !== undefined;
    if (!alreadySet) kept[key] = value;
  }
  return kept;
}

/** Candidate-facing copy naming every gap at once, never one per message. */
export function profileGateMessage(missing: string[], role: string) {
  return applicationPauseMessage(
    "user_input",
    `before starting ${role} the profile is missing: ${missing.join("; ")}. Save them with candidate_profile, then start again.`
  );
}
