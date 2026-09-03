import type {
  CandidateContactIdentity,
  CandidateProfile,
  CandidateProfilePatch,
} from "@/lib/candidate-profile";
import type { SelfIdentification } from "@/lib/self-identification";

export interface VisibleFormField {
  label: string;
  name: string;
  /** Choices for a select, radio group, or combobox; empty for free text. */
  options?: string[];
  required: boolean;
  selector: string;
  tag: string;
  type: string;
}

export interface MappedFill {
  /**
   * Other wording that answers the same question. A control's real options are
   * often unreadable until it is opened, so the fill carries every phrasing the
   * profile knows and matches against what the page actually offers.
   */
  alternatives?: string[];
  selector: string;
  value: string;
}

/** The stored enum paired with the wording a form would show for it. */
const workAuthorizationOptions = [
  ["other", "Other"],
  ["requires_sponsorship", "I will require sponsorship"],
  ["us_citizen", "U.S. Citizen"],
  ["us_permanent_resident", "Permanent Resident"],
  ["us_visa_no_sponsorship", "Authorized to work, no sponsorship needed"],
] as const satisfies readonly (readonly [
  CandidateProfile["workAuthorization"],
  string,
])[];

const workAuthorizationLabels: Record<string, string> = Object.fromEntries(
  workAuthorizationOptions
);

/**
 * The wording an ATS uses to let a candidate say nothing. These questions are
 * voluntary by law and always offer one, so an unanswered field is declined
 * rather than asked about: a run must never stall on a question the candidate
 * is entitled to skip.
 */
const declineOptions = [
  "Decline to self identify",
  "I don't wish to answer",
  "I do not wish to answer",
  "Prefer not to say",
  "Prefer not to answer",
  "Decline to answer",
  "I don't wish to answer.",
] as const;

/** How a page words agreement, once the candidate has consented in general. */
const agreementOptions = [
  "Yes",
  "I agree",
  "Agree",
  "I acknowledge",
  "Acknowledge",
  "Accept",
  "I accept",
] as const;

/**
 * A question that only records a permission, never a fact.
 *
 * Acknowledging a privacy notice and allowing contact are the boilerplate
 * every ATS asks and no candidate wants relayed to them one message at a
 * time. A claim about the candidate — where they worked, how long, how old
 * they are — is never in here: answering one of those on their behalf would
 * put a statement they never made on an employer's form.
 */
function consentQuestion(key: string) {
  if (/worked|employed|employee|relative|referr|intern(ship)?\b/u.test(key)) {
    return false;
  }
  return /acknowledg|consent|privacy|terms|policy|i agree|opt.?in|receive (communications|texts|messages)|sms|whatsapp|text message|contact you|contacted/u.test(
    key
  );
}

/**
 * A voluntary disclosure with no stored answer to draw on. "Do you identify as
 * transgender?" contains the word gender but is a different question, and the
 * candidate's gender must never be offered as its answer; it is declined like
 * any other EEO question the candidate has not chosen to answer.
 */
function voluntaryDisclosure(key: string) {
  return /transgender|sexual orientation|lgbt/u.test(key);
}

/** The four voluntary EEO fields, and which stored answer belongs to each. */
function selfIdentificationKey(
  key: string
): keyof SelfIdentification | undefined {
  if (voluntaryDisclosure(key)) return undefined;
  if (/disab/u.test(key)) return "disabilityStatus";
  if (/veteran/u.test(key)) return "veteranStatus";
  // "Are you Hispanic or Latino?" is the EEO-1 ethnicity question asked on its
  // own; without this it read as an ordinary required question and stalled.
  if (/race|ethnic|hispanic|latin/u.test(key)) return "raceEthnicity";
  if (/gender|\bsex\b/u.test(key)) return "gender";
  return undefined;
}

/**
 * A question about the candidate's state or province, as opposed to one that
 * merely mentions the United States. "Are you legally authorized to work in
 * the United States?" matched the State field first, so the profile's region
 * was offered as the answer and a Yes typed by the candidate was then stored
 * as their state.
 */
function asksForRegion(key: string) {
  return /\b(state|region|province)\b/u.test(
    key.replace(/united states( of america)?|\bu ?s ?a?\b/gu, " ")
  );
}

/** Whether a file control is asking for the resume, by its own wording. */
function asksForResume(field: VisibleFormField) {
  return /resume|\bcv\b|curriculum/u.test(normalize(field.label, field.name));
}

/**
 * Deterministic mapping from a candidate profile onto visible form controls.
 * Unmapped required fields are returned for the bounded LLM helper — never a
 * screenshot loop.
 */
export function mapProfileToFormFields(input: {
  fields: VisibleFormField[];
  identity: CandidateContactIdentity;
  profile: CandidateProfile;
  resumePath?: string;
  selfIdentification?: SelfIdentification;
}): { fills: MappedFill[]; unmapped: VisibleFormField[] } {
  const fills: MappedFill[] = [];
  const unmapped: VisibleFormField[] = [];
  const isFile = (field: VisibleFormField) =>
    field.tag === "file" || field.type === "file";
  const fileFields = input.fields.filter(isFile);
  for (const field of input.fields) {
    if (isFile(field)) {
      // The resume goes to the control asking for it, or to the only file
      // control on the form. A cover letter slot is not a place for it.
      const wantsResume = asksForResume(field) || fileFields.length === 1;
      if (input.resumePath && wantsResume) {
        fills.push({ selector: field.selector, value: input.resumePath });
      } else if (field.required) {
        unmapped.push(field);
      }
      continue;
    }
    const value = valueForField(
      field,
      input.profile,
      input.identity,
      input.selfIdentification ?? {}
    );
    const resolved =
      value === undefined || value === ""
        ? undefined
        : resolveWithAlternatives(field, value);
    if (resolved !== undefined) {
      fills.push({
        alternatives: alternativesFor(field, value ?? resolved),
        selector: field.selector,
        value: resolved,
      });
    } else if (field.required) {
      unmapped.push(field);
    }
  }
  return { fills, unmapped };
}

/**
 * The profile field a question was asking about, so an answer given once in
 * chat is kept instead of being asked for again on the next posting.
 *
 * Deliberately narrower than `valueForField`: only facts a candidate states
 * plainly and would expect us to remember. Contact details belong to the
 * identity record, and anything a form might ask that is a secret — a
 * password, an SSN, a date of birth — has no entry here and never will.
 */
export function profilePatchForAnswer(
  field: VisibleFormField,
  answer: string,
  profile?: CandidateProfile
): CandidateProfilePatch | undefined {
  const value = answer.trim();
  if (value === "") return undefined;
  const key = normalize(field.label, field.name, field.type);
  // A profile link is read from the profile on every fill but was never
  // written back from an answer, so "LinkedIn Profile" was asked on every
  // posting forever however many times the candidate typed it.
  const linkLabel = profileLinkLabel(key);
  if (linkLabel) return linkPatch(linkLabel, value, profile);
  if (/password|ssn|social.?security|date.?of.?birth|birth.?date/u.test(key)) {
    return undefined;
  }
  if (/first.?name|given.?name|legal.?first/u.test(key)) {
    return { legalFirstName: value };
  }
  if (/last.?name|family.?name|surname|legal.?last/u.test(key)) {
    return { legalLastName: value };
  }
  if (/preferred.?name|nickname/u.test(key)) return { preferredName: value };
  // A contact address the candidate gave for their own applications. Not a
  // credential, and not the verified login identity, which only Better Auth
  // may set.
  if (/e.?mail/u.test(key)) {
    return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/u.test(value)
      ? { contactEmail: value }
      : undefined;
  }
  // Work status before location, in the same order `valueForField` reads
  // them: an authorization question mentions the country it is about.
  if (/sponsor/u.test(key)) {
    const answered = yesNoFromAnswer(value);
    if (!answered) return undefined;
    // "Now or in the future" is one question over two facts. A no settles
    // both; a yes only says the future one, since it may not be needed now.
    if (/future/u.test(key)) {
      return answered === "no"
        ? { requiresSponsorshipFuture: "no", requiresSponsorshipNow: "no" }
        : { requiresSponsorshipFuture: "yes" };
    }
    return { requiresSponsorshipNow: answered };
  }
  if (/relocat/u.test(key)) {
    const answered = yesNoFromAnswer(value);
    return answered ? { willingToRelocate: answered } : undefined;
  }
  if (/authoriz|work.?eligib|citizenship/u.test(key)) {
    const authorization = workAuthorizationFromAnswer(value);
    return authorization ? { workAuthorization: authorization } : undefined;
  }
  if (/city/u.test(key)) return { locationCity: value };
  if (asksForRegion(key)) return { locationRegion: value };
  if (/zip|postal/u.test(key)) return { locationPostalCode: value };
  if (/headline|title/u.test(key)) return { headline: value };
  if (/start.?date|earliest.?start|available/u.test(key)) {
    return { earliestStartDate: value };
  }
  if (/salary|compensation|pay.?expect/u.test(key)) {
    const digits = value.replace(/[^0-9]/gu, "");
    if (digits === "") return undefined;
    const amount = Number.parseInt(digits, 10);
    return Number.isFinite(amount) ? { salaryMin: amount } : undefined;
  }
  return undefined;
}

/**
 * The control a question was about, found again by its label.
 *
 * A pause names questions by label because that is the one thing that
 * survives a re-scan: selectors are positional when a control has no id, and
 * a page re-render shifts them. Both sides are normalized the same way, so a
 * trailing asterisk or a stray space does not lose the match.
 */
export function matchFieldByLabel(
  fields: VisibleFormField[],
  question: string
): VisibleFormField | undefined {
  const wanted = normalize(question);
  if (wanted === "") return undefined;
  const exact = fields.find((field) => normalize(field.label) === wanted);
  if (exact) return exact;
  const loose = fields.filter((field) => {
    const label = normalize(field.label);
    return (
      label.length >= 4 && (label.includes(wanted) || wanted.includes(label))
    );
  });
  return loose.length === 1 ? loose[0] : undefined;
}

/**
 * The candidate's answer to a question, as a fill for that control.
 *
 * The answer is matched against the control's options where they were read
 * at scan time, and carries every other phrasing that means the same thing,
 * so a Yes to "authorized to work" lands on a control that only offers those
 * two words. When nothing resolves, the answer itself is tried: the page then
 * reports what it would accept instead.
 */
export function fillForAnswer(
  field: VisibleFormField,
  answer: string
): MappedFill | undefined {
  const value = answer.trim();
  if (value === "") return undefined;
  const resolved = resolveAgainstOptions(field, value) ?? value;
  return {
    alternatives: alternativesFor(field, value),
    selector: field.selector,
    value: resolved,
  };
}

/** The kind of link a question is asking for, if it is asking for one. */
function profileLinkLabel(key: string) {
  if (/linkedin/u.test(key)) return "LinkedIn";
  if (/github/u.test(key)) return "GitHub";
  if (/portfolio|personal (site|website)|website|url/u.test(key)) {
    return "Portfolio";
  }
  return undefined;
}

/**
 * The candidate's links with this one added or replaced.
 *
 * A save replaces the whole array, so the existing links have to be carried
 * through here or answering one question would delete the rest.
 */
function linkPatch(
  label: string,
  value: string,
  profile: CandidateProfile | undefined
): CandidateProfilePatch | undefined {
  const url = /^https?:\/\//iu.test(value) ? value : `https://${value}`;
  if (!/^https?:\/\/[^\s.]+\.[^\s]{2,}$/iu.test(url)) return undefined;
  const existing = (profile?.links ?? []).filter(
    (link) => link.label.toLowerCase() !== label.toLowerCase()
  );
  return { links: [...existing, { label, url }] };
}

function yesNoFromAnswer(value: string): "yes" | "no" | undefined {
  if (/^\s*(yes|y|true)\b/iu.test(value)) return "yes";
  if (/^\s*(no|n|false)\b/iu.test(value)) return "no";
  return undefined;
}

function workAuthorizationFromAnswer(
  value: string
): CandidateProfile["workAuthorization"] | undefined {
  const text = value.trim().toLowerCase();
  const labelled = workAuthorizationOptions.find(
    ([, label]) => label.toLowerCase() === text
  );
  if (labelled) return labelled[0];
  if (/citizen/u.test(text)) return "us_citizen";
  if (/permanent.?resident|green.?card/u.test(text)) {
    return "us_permanent_resident";
  }
  if (/require[sd]?\s+sponsorship|need.*sponsor/u.test(text)) {
    return "requires_sponsorship";
  }
  // A bare yes to "are you authorized" is only ever that much: authorized
  // without sponsorship. Anything vaguer stays unset rather than guessed.
  if (/^\s*(yes|y|true)\b/iu.test(text)) return "us_visa_no_sponsorship";
  return undefined;
}

function valueForField(
  field: VisibleFormField,
  profile: CandidateProfile,
  identity: CandidateContactIdentity,
  selfIdentification: SelfIdentification
): string | undefined {
  const key = normalize(field.label, field.name, field.type);
  // Before anything else: the questions with a standing answer. Left to the
  // generic matches below, "Applicant Privacy Acknowledgement" and "receive
  // communications via SMS" fell through to nothing and stopped the run.
  const eeoField = selfIdentificationKey(key);
  if (eeoField) return selfIdentification[eeoField] ?? declineOptions[0];
  if (voluntaryDisclosure(key)) return declineOptions[0];
  if (consentQuestion(key)) return "Yes";
  // `normalize` turns "E-mail" into "e mail", so match both spellings. The
  // verified auth address wins; the profile one is the fallback for a
  // candidate who only ever texts and has no verified login email.
  if (/e.?mail/u.test(key) || field.type === "email") {
    return identity.email ?? profile.contactEmail;
  }
  if (/(mobile|phone|tel)/u.test(key) || field.type === "tel") {
    return identity.phone;
  }
  if (/first.?name|given.?name|legal.?first/u.test(key)) {
    return profile.legalFirstName;
  }
  if (/last.?name|family.?name|surname|legal.?last/u.test(key)) {
    return profile.legalLastName;
  }
  if (/preferred.?name|nickname/u.test(key)) {
    return profile.preferredName || profile.legalFirstName;
  }
  if (/^name$|full.?name|legal.?name/u.test(key)) {
    return [profile.legalFirstName, profile.legalLastName]
      .filter(Boolean)
      .join(" ");
  }
  // Work status before location: "authorized to work in the United States"
  // and "in the country where this role is located" are about authorization,
  // not an address, and the first of those used to be answered with a state.
  if (/sponsor/u.test(key)) {
    return yesNo(profile.requiresSponsorshipNow);
  }
  if (/authoriz|work.?eligib|citizenship/u.test(key)) {
    return workAuthorizationLabels[profile.workAuthorization];
  }
  if (/relocat/u.test(key)) return yesNo(profile.willingToRelocate);
  if (/city/u.test(key)) return profile.locationCity;
  if (asksForRegion(key)) return profile.locationRegion;
  if (/zip|postal/u.test(key)) return profile.locationPostalCode;
  if (/country/u.test(key)) return profile.locationCountryCode;
  if (/linkedin/u.test(key)) {
    return profile.links.find((link) =>
      /linkedin/iu.test(link.label + link.url)
    )?.url;
  }
  if (/github/u.test(key)) {
    return profile.links.find((link) => /github/iu.test(link.label + link.url))
      ?.url;
  }
  if (/start.?date|earliest.?start|available/u.test(key)) {
    return profile.earliestStartDate;
  }
  if (/salary|compensation|pay.?expect/u.test(key)) {
    if (profile.salaryMin == null) return undefined;
    return String(profile.salaryMin);
  }
  if (/headline|title/u.test(key) && profile.headline) return profile.headline;
  return undefined;
}

/**
 * Every other phrasing that answers the same question.
 *
 * A closed control frequently cannot be read until it is opened, so the value
 * alone is not enough: the profile says "U.S. Citizen" where the posting
 * offers Yes/No. Carrying both lets the fill match against the real options
 * without a second pass.
 */
function alternativesFor(field: VisibleFormField, value: string) {
  const alternatives = new Set<string>();
  const affirmative = affirmativeAnswer(value);
  if (affirmative !== undefined) {
    alternatives.add(affirmative ? "Yes" : "No");
  }
  const key = normalize(field.label, field.name, field.type);
  if (/authoriz|work.?eligib|citizenship/u.test(key)) {
    for (const [, label] of workAuthorizationOptions) alternatives.add(label);
  }
  // Every page words these differently and the scan often cannot read the
  // options until the control is opened, so carry all of them.
  if (selfIdentificationKey(key) || voluntaryDisclosure(key)) {
    for (const option of declineOptions) alternatives.add(option);
  }
  if (consentQuestion(key)) {
    for (const option of agreementOptions) alternatives.add(option);
  }
  alternatives.delete(value);
  return alternatives.size > 0 ? [...alternatives] : undefined;
}

/**
 * The first phrasing this control will accept.
 *
 * A page words the same answer its own way — "Decline to self identify" here,
 * "I don't wish to answer" there, "I agree" where another says "Yes" — so the
 * value alone often matches nothing and the field was reported as unanswerable
 * when we knew the answer perfectly well. The alternatives are already
 * assembled for the browser; the same list settles it here, where the options
 * are known.
 */
function resolveWithAlternatives(field: VisibleFormField, value: string) {
  const direct = resolveAgainstOptions(field, value);
  if (direct !== undefined) return direct;
  for (const alternative of alternativesFor(field, value) ?? []) {
    const resolved = resolveAgainstOptions(field, alternative);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/**
 * Bends a profile answer onto the choices a control actually offers.
 *
 * The profile speaks in its own vocabulary ("Authorized to work, no
 * sponsorship needed") while an ATS usually asks the same thing as Yes/No.
 * Without this the value matches no option, the control stays empty, and the
 * question that blocks the submission looks answered. Returning undefined
 * sends the field to the unmapped list, where a required one becomes a pause
 * instead of a silent gap.
 */
function resolveAgainstOptions(field: VisibleFormField, value: string) {
  const options = field.options ?? [];
  if (options.length === 0) return value;
  const wanted = value.trim().toLowerCase();
  const exact = options.find(
    (option) => option.trim().toLowerCase() === wanted
  );
  if (exact) return exact;
  const partial = options.find((option) => {
    const text = option.trim().toLowerCase();
    return text.startsWith(wanted) || wanted.startsWith(text);
  });
  if (partial) return partial;
  const affirmative = affirmativeAnswer(value);
  if (affirmative === undefined) return undefined;
  return options.find((option) =>
    affirmative
      ? /^\s*(yes|y|true)\b/iu.test(option)
      : /^\s*(no|n|false)\b/iu.test(option)
  );
}

/** Whether a profile answer reads as yes, for a control that only offers both. */
function affirmativeAnswer(value: string) {
  const text = value.trim().toLowerCase();
  if (/^(yes|true)$/u.test(text)) return true;
  if (/^(no|false)$/u.test(text)) return false;
  if (/require[sd]?\s+sponsorship/u.test(text)) return false;
  if (
    /citizen|permanent resident|authorized to work|no sponsorship/u.test(text)
  ) {
    return true;
  }
  return undefined;
}

function yesNo(value: string) {
  if (value === "yes") return "Yes";
  if (value === "no") return "No";
  return undefined;
}

function normalize(...parts: string[]) {
  return parts
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}
