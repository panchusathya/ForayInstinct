import type {
  CandidateContactIdentity,
  CandidateProfile,
  CandidateProfilePatch,
} from "@/lib/candidate-profile";

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
 * Deterministic mapping from a candidate profile onto visible form controls.
 * Unmapped required fields are returned for the bounded LLM helper — never a
 * screenshot loop.
 */
export function mapProfileToFormFields(input: {
  fields: VisibleFormField[];
  identity: CandidateContactIdentity;
  profile: CandidateProfile;
  resumePath?: string;
}): { fills: MappedFill[]; unmapped: VisibleFormField[] } {
  const fills: MappedFill[] = [];
  const unmapped: VisibleFormField[] = [];
  for (const field of input.fields) {
    if (field.tag === "file" || field.type === "file") {
      if (input.resumePath) {
        fills.push({ selector: field.selector, value: input.resumePath });
      } else {
        unmapped.push(field);
      }
      continue;
    }
    const value = valueForField(field, input.profile, input.identity);
    const resolved =
      value === undefined || value === ""
        ? undefined
        : resolveAgainstOptions(field, value);
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
  answer: string
): CandidateProfilePatch | undefined {
  const value = answer.trim();
  if (value === "") return undefined;
  const key = normalize(field.label, field.name, field.type);
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
  if (/city/u.test(key)) return { locationCity: value };
  if (/state|region|province/u.test(key)) return { locationRegion: value };
  if (/zip|postal/u.test(key)) return { locationPostalCode: value };
  if (/headline|title/u.test(key)) return { headline: value };
  if (/start.?date|earliest.?start|available/u.test(key)) {
    return { earliestStartDate: value };
  }
  if (/sponsor/u.test(key)) {
    const answered = yesNoFromAnswer(value);
    return answered ? { requiresSponsorshipNow: answered } : undefined;
  }
  if (/relocat/u.test(key)) {
    const answered = yesNoFromAnswer(value);
    return answered ? { willingToRelocate: answered } : undefined;
  }
  if (/authoriz|work.?eligib|citizenship/u.test(key)) {
    const authorization = workAuthorizationFromAnswer(value);
    return authorization ? { workAuthorization: authorization } : undefined;
  }
  if (/salary|compensation|pay.?expect/u.test(key)) {
    const digits = value.replace(/[^0-9]/gu, "");
    if (digits === "") return undefined;
    const amount = Number.parseInt(digits, 10);
    return Number.isFinite(amount) ? { salaryMin: amount } : undefined;
  }
  return undefined;
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
  identity: CandidateContactIdentity
): string | undefined {
  const key = normalize(field.label, field.name, field.type);
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
  if (/city/u.test(key)) return profile.locationCity;
  if (/state|region|province/u.test(key)) return profile.locationRegion;
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
  if (/sponsor/u.test(key)) {
    return yesNo(profile.requiresSponsorshipNow);
  }
  if (/authoriz|work.?eligib|citizenship/u.test(key)) {
    return workAuthorizationLabels[profile.workAuthorization];
  }
  if (/relocat/u.test(key)) return yesNo(profile.willingToRelocate);
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
  alternatives.delete(value);
  return alternatives.size > 0 ? [...alternatives] : undefined;
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
