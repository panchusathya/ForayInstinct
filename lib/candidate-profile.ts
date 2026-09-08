import { z } from "zod";

/**
 * Structured facts the worker needs to complete an ATS profile wizard. This is
 * not the Better Auth user row and not EEO answers (those stay in
 * `settings.self_identification`). SSN, date of birth, government IDs,
 * references, and any password are excluded on purpose.
 */

/**
 * Every bound the profile enforces, in one place, so the form can stop input
 * at the same length the schema refuses and the two never disagree.
 */
export const profileLimits = {
  code: 8,
  description: 4_000,
  education: 20,
  linkLabel: 80,
  links: 20,
  locality: 120,
  name: 80,
  postalCode: 20,
  shortText: 200,
  skill: 80,
  skills: 40,
  startDate: 80,
  summary: 8_000,
  url: 500,
  workHistory: 30,
} as const;

const boundedText = (max: number) => z.string().trim().max(max).default("");
const monthSchema = z.number().int().min(1).max(12);
const yearSchema = z.number().int().min(1900).max(2100);

const workAuthorizationSchema = z.enum([
  "",
  "us_citizen",
  "us_permanent_resident",
  "us_visa_no_sponsorship",
  "requires_sponsorship",
  "other",
]);

const yesNoBlankSchema = z.enum(["", "yes", "no"]);
const salaryPeriodSchema = z.enum(["", "year", "hour"]);
const workArrangementSchema = z.enum([
  "",
  "remote",
  "hybrid",
  "onsite",
  "flexible",
]);

const workHistoryEntrySchema = z.object({
  company: boundedText(profileLimits.shortText),
  current: z.boolean().default(false),
  description: boundedText(profileLimits.description),
  endMonth: monthSchema.optional(),
  endYear: yearSchema.optional(),
  location: boundedText(profileLimits.shortText),
  startMonth: monthSchema.optional(),
  startYear: yearSchema.optional(),
  title: boundedText(profileLimits.shortText),
});

const educationEntrySchema = z.object({
  current: z.boolean().default(false),
  degree: boundedText(profileLimits.shortText),
  endMonth: monthSchema.optional(),
  endYear: yearSchema.optional(),
  field: boundedText(profileLimits.shortText),
  school: boundedText(profileLimits.shortText),
  startMonth: monthSchema.optional(),
  startYear: yearSchema.optional(),
});

const profileLinkSchema = z.object({
  label: boundedText(profileLimits.linkLabel),
  url: boundedText(profileLimits.url),
});

// A write that fails validation fails: these arrays used to `.catch([])`, so
// one over-long description turned the whole work history into an empty
// array that was then saved, under a "Saved." message. The lenient reading
// of what is already stored lives in `storedCandidateProfileSchema`.
const skillSchema = z.string().trim().min(1).max(profileLimits.skill);
const skillsSchema = z.array(skillSchema).max(profileLimits.skills).default([]);
const linksSchema = z
  .array(profileLinkSchema)
  .max(profileLimits.links)
  .default([]);
const workHistorySchema = z
  .array(workHistoryEntrySchema)
  .max(profileLimits.workHistory)
  .default([]);
const educationSchema = z
  .array(educationEntrySchema)
  .max(profileLimits.education)
  .default([]);

const salaryAmountSchema = z
  .number()
  .int()
  .min(0)
  .max(10_000_000)
  .nullable()
  .default(null);

export const candidateProfileSchema = z.object({
  /**
   * The address the candidate puts on applications. Separate from the Better
   * Auth row on purpose: that one is a verified login identity, and a
   * candidate who only ever texts has none, so a form's Email field had no
   * value to draw on and was asked for on every posting.
   */
  contactEmail: boundedText(320),
  earliestStartDate: boundedText(profileLimits.startDate),
  education: educationSchema,
  headline: boundedText(profileLimits.shortText),
  legalFirstName: boundedText(profileLimits.name),
  legalLastName: boundedText(profileLimits.name),
  links: linksSchema,
  locationCity: boundedText(profileLimits.locality),
  locationCountryCode: boundedText(profileLimits.code),
  locationPostalCode: boundedText(profileLimits.postalCode),
  locationRegion: boundedText(profileLimits.locality),
  preferredName: boundedText(profileLimits.name),
  requiresSponsorshipFuture: yesNoBlankSchema.default(""),
  requiresSponsorshipNow: yesNoBlankSchema.default(""),
  salaryCurrency: boundedText(profileLimits.code).default("USD"),
  salaryMax: salaryAmountSchema,
  salaryMin: salaryAmountSchema,
  salaryPeriod: salaryPeriodSchema.default(""),
  skills: skillsSchema,
  summary: boundedText(profileLimits.summary),
  willingToRelocate: yesNoBlankSchema.default(""),
  workArrangement: workArrangementSchema.default(""),
  workAuthorization: workAuthorizationSchema.default(""),
  workHistory: workHistorySchema,
  yearsExperience: z.number().int().min(0).max(80).nullable().default(null),
});

export type CandidateProfile = z.infer<typeof candidateProfileSchema>;
export type WorkHistoryEntry = z.infer<typeof workHistoryEntrySchema>;
export type EducationEntry = z.infer<typeof educationEntrySchema>;
export type ProfileLink = z.infer<typeof profileLinkSchema>;

export const emptyCandidateProfile: CandidateProfile =
  candidateProfileSchema.parse({});

export const candidateProfilePatchSchema = candidateProfileSchema.partial();
export type CandidateProfilePatch = z.infer<typeof candidateProfilePatchSchema>;

/** Stored text is clipped to the bound, never dropped for exceeding it. */
const storedText = (max: number, fallback = "") =>
  z
    .string()
    .catch(fallback)
    .transform((value) => value.trim().slice(0, max));

/**
 * Keeps the entries that still parse and drops the rest, one element at a
 * time. A whole-array `.catch([])` read thirty positions as none the moment
 * one of them had gone stale.
 */
function tolerantArray<T extends z.ZodType>(item: T, max: number) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((entries) =>
      entries
        .flatMap((entry) => {
          const parsed = item.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })
        .slice(0, max)
    );
}

/**
 * How a row already in the database is read: every field on its own, with
 * the empty value standing in for one that no longer parses. Writes go
 * through `candidateProfileSchema` and are refused instead.
 */
export const storedCandidateProfileSchema = z.object({
  contactEmail: storedText(320),
  earliestStartDate: storedText(profileLimits.startDate),
  education: tolerantArray(educationEntrySchema, profileLimits.education),
  headline: storedText(profileLimits.shortText),
  legalFirstName: storedText(profileLimits.name),
  legalLastName: storedText(profileLimits.name),
  links: tolerantArray(profileLinkSchema, profileLimits.links),
  locationCity: storedText(profileLimits.locality),
  locationCountryCode: storedText(profileLimits.code),
  locationPostalCode: storedText(profileLimits.postalCode),
  locationRegion: storedText(profileLimits.locality),
  preferredName: storedText(profileLimits.name),
  requiresSponsorshipFuture: yesNoBlankSchema.catch(""),
  requiresSponsorshipNow: yesNoBlankSchema.catch(""),
  salaryCurrency: storedText(profileLimits.code, "USD"),
  salaryMax: salaryAmountSchema.catch(null),
  salaryMin: salaryAmountSchema.catch(null),
  salaryPeriod: salaryPeriodSchema.catch(""),
  skills: tolerantArray(skillSchema, profileLimits.skills),
  summary: storedText(profileLimits.summary),
  willingToRelocate: yesNoBlankSchema.catch(""),
  workArrangement: workArrangementSchema.catch(""),
  workAuthorization: workAuthorizationSchema.catch(""),
  workHistory: tolerantArray(workHistoryEntrySchema, profileLimits.workHistory),
  yearsExperience: z.number().int().min(0).max(80).nullable().catch(null),
});

/**
 * The name Better Auth gives a phone sign-up before the candidate has said
 * theirs. It is not a name: seeded into a legal-name field it reached ATS
 * forms as "Phone" "user".
 */
export function isPlaceholderName(name: string) {
  return /^phone user$/iu.test(name.trim());
}

/**
 * Validates a patch without inventing the keys it did not mention.
 *
 * Parsing through the patch schema alone fills in every `.default()`, so a
 * one-field patch comes back carrying `workAuthorization: ""` and the rest.
 * Merged over a stored profile that clears real answers, which is how a
 * profile went backwards between applications. Anything writing a patch
 * assembled from partial knowledge must come through here.
 */
export function profilePatchOf(
  input: Record<string, unknown>
): CandidateProfilePatch | undefined {
  const parsed = parseProfilePatch(input);
  return parsed.ok ? parsed.patch : undefined;
}

/**
 * `profilePatchOf`, with the reason when the patch is refused: which field,
 * and what was wrong with it. A form that saved thirty positions and one
 * over-long description was told only "Could not save profile."
 */
export function parseProfilePatch(
  input: Record<string, unknown>
):
  | { ok: true; patch: CandidateProfilePatch | undefined }
  | { ok: false; issues: { message: string; path: string }[] } {
  // A key carrying `undefined` was not stated either: the patch schema would
  // hand it the default, and that default would then clear a stored answer.
  const provided = new Set(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
  );
  if (provided.size === 0) return { ok: true, patch: undefined };
  const parsed = candidateProfilePatchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path.map(String).join("."),
      })),
      ok: false,
    };
  }
  const stated: CandidateProfilePatch = {};
  let kept = 0;
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!provided.has(key)) continue;
    Object.assign(stated, { [key]: value });
    kept += 1;
  }
  return { ok: true, patch: kept > 0 ? stated : undefined };
}

/**
 * The fields of `next` that differ from `base`, as a patch. The profile page
 * used to send its whole snapshot on every save, so a field left stale in one
 * tab was written back over the answer given in another.
 */
export function profileDiff(
  base: CandidateProfile,
  next: CandidateProfile
): CandidateProfilePatch {
  const before: Record<string, unknown> = { ...base };
  const after: Record<string, unknown> = { ...next };
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(candidateProfileSchema.shape)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      patch[key] = after[key];
    }
  }
  return profilePatchOf(patch) ?? {};
}

/**
 * The candidate's own entries always win over anything read off a resume or
 * a form. Links are the one list that merges: a LinkedIn URL found on the
 * resume joins the links the candidate typed rather than being dropped
 * because they typed any at all. An empty list counts as unset.
 */
export function onlyUnset(
  stored: CandidateProfile,
  patch: CandidateProfilePatch
) {
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

const candidateContactIdentitySchema = z.object({
  email: z.string().optional(),
  name: z.string(),
  phone: z.string().optional(),
});

export const candidateProfileResponseSchema = z.object({
  identity: candidateContactIdentitySchema,
  kernelProfileId: z.string(),
  profile: candidateProfileSchema,
  /**
   * When the stored profile last changed, as the row records it. The page
   * hands it back with a save so a write against a snapshot another save has
   * replaced is refused instead of silently winning.
   */
  updatedAt: z.string().default(""),
});

export type CandidateContactIdentity = z.infer<
  typeof candidateContactIdentitySchema
>;
export type CandidateProfileResponse = z.infer<
  typeof candidateProfileResponseSchema
>;

/**
 * Facts an ATS wizard is likely to require and we do not have.
 *
 * `blocking` is the difference between a fact no application can start without
 * and one a form asks for when it gets there: reciting all nine at intake read
 * as an interrogation, and the worker reports a field it actually needs as a
 * `Needs user input:` blocker anyway.
 *
 * `onResume` marks a fact the resume already carries. Asking a candidate to
 * type their legal name into chat while their resume sits on file is asking
 * twice for the same thing.
 */
const missingFieldChecks: readonly {
  readonly blocking: boolean;
  readonly label: string;
  readonly missing: (profile: CandidateProfile) => boolean;
  readonly onResume: boolean;
}[] = [
  {
    blocking: true,
    label: "legal first name",
    missing: (profile) => profile.legalFirstName.length === 0,
    onResume: true,
  },
  {
    blocking: true,
    label: "legal last name",
    missing: (profile) => profile.legalLastName.length === 0,
    onResume: true,
  },
  {
    blocking: false,
    label: "city",
    missing: (profile) => profile.locationCity.length === 0,
    onResume: true,
  },
  {
    blocking: false,
    label: "region / state",
    missing: (profile) => profile.locationRegion.length === 0,
    onResume: true,
  },
  {
    blocking: false,
    label: "country",
    missing: (profile) => profile.locationCountryCode.length === 0,
    onResume: true,
  },
  {
    blocking: true,
    label: "work authorization",
    missing: (profile) => profile.workAuthorization.length === 0,
    onResume: false,
  },
  {
    blocking: true,
    label: "sponsorship needed now",
    missing: (profile) => profile.requiresSponsorshipNow.length === 0,
    onResume: false,
  },
  {
    blocking: false,
    label: "sponsorship needed in the future",
    missing: (profile) => profile.requiresSponsorshipFuture.length === 0,
    onResume: false,
  },
  {
    blocking: true,
    label: "work history",
    missing: (profile) => profile.workHistory.length === 0,
    onResume: true,
  },
];

/**
 * The labels worth asking a candidate for right now. Pass `hasResume` so facts
 * the resume already carries drop out instead of being asked for twice.
 */
export function missingProfileFields(
  profile: CandidateProfile,
  options: { readonly hasResume?: boolean } = {}
): string[] {
  return missingFieldChecks
    .filter(
      (field) =>
        field.blocking &&
        field.missing(profile) &&
        !(options.hasResume && field.onResume)
    )
    .map((field) => field.label);
}

const maxPositions = 5;
const maxDescription = 180;

export function candidateProfileSummary(
  profile: CandidateProfile,
  identity: {
    readonly email?: string;
    readonly name: string;
    readonly phone?: string;
  },
  options: { readonly allPositions?: boolean } = {}
) {
  const positions = options.allPositions
    ? profile.workHistory
    : profile.workHistory.slice(0, maxPositions);
  const truncated =
    profile.workHistory.length > positions.length ||
    profile.workHistory.some(
      (entry) => entry.description.length > maxDescription
    );

  const lines = [
    `Name: ${displayName(profile, identity.name)}`,
    identity.email ? `Email: ${identity.email}` : undefined,
    identity.phone ? `Phone: ${identity.phone}` : undefined,
    locationLine(profile) ? `Location: ${locationLine(profile)}` : undefined,
    profile.workAuthorization
      ? `Work authorization: ${profile.workAuthorization}`
      : undefined,
    profile.requiresSponsorshipNow
      ? `Sponsorship now: ${profile.requiresSponsorshipNow}`
      : undefined,
    profile.requiresSponsorshipFuture
      ? `Sponsorship future: ${profile.requiresSponsorshipFuture}`
      : undefined,
    compensationLine(profile),
    profile.earliestStartDate
      ? `Earliest start: ${profile.earliestStartDate}`
      : undefined,
    profile.workArrangement
      ? `Work arrangement: ${profile.workArrangement}`
      : undefined,
    profile.willingToRelocate
      ? `Willing to relocate: ${profile.willingToRelocate}`
      : undefined,
    profile.yearsExperience !== null
      ? `Years of experience: ${String(profile.yearsExperience)}`
      : undefined,
    profile.headline ? `Headline: ${profile.headline}` : undefined,
    profile.summary ? `Summary: ${clip(profile.summary, 400)}` : undefined,
    profile.skills.length > 0
      ? `Skills: ${profile.skills.join(", ")}`
      : undefined,
    profile.links.length > 0
      ? `Links: ${profile.links
          .map((link) => `${link.label || "link"} ${link.url}`.trim())
          .join("; ")}`
      : undefined,
    positions.length > 0
      ? `Work history:\n${positions.map(formatWorkHistory).join("\n")}`
      : undefined,
    profile.education.length > 0
      ? `Education:\n${profile.education.map(formatEducation).join("\n")}`
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return { text: lines.join("\n"), truncated };
}

function displayName(profile: CandidateProfile, identityName: string) {
  const legal = `${profile.legalFirstName} ${profile.legalLastName}`.trim();
  const preferred = profile.preferredName;
  if (legal && preferred && preferred !== profile.legalFirstName) {
    return `${legal} (preferred ${preferred})`;
  }
  return legal || identityName || "(not set)";
}

function locationLine(profile: CandidateProfile) {
  return [
    profile.locationCity,
    profile.locationRegion,
    profile.locationPostalCode,
    profile.locationCountryCode,
  ]
    .filter(Boolean)
    .join(", ");
}

function compensationLine(profile: CandidateProfile) {
  if (profile.salaryMin === null && profile.salaryMax === null)
    return undefined;
  const currency = profile.salaryCurrency || "USD";
  const period = profile.salaryPeriod ? ` per ${profile.salaryPeriod}` : "";
  if (profile.salaryMin !== null && profile.salaryMax !== null) {
    return `Compensation: ${currency} ${String(profile.salaryMin)}–${String(profile.salaryMax)}${period}`;
  }
  const amount = profile.salaryMin ?? profile.salaryMax;
  return `Compensation: ${currency} ${String(amount)}${period}`;
}

/** One work or education entry, worded as the profile summary words it. */
export function formatProfileEntry(entry: WorkHistoryEntry | EducationEntry) {
  return "company" in entry ? formatWorkHistory(entry) : formatEducation(entry);
}

function formatWorkHistory(entry: WorkHistoryEntry) {
  const dates = formatDateRange(entry);
  const header = [entry.title, entry.company, entry.location, dates]
    .filter(Boolean)
    .join(" · ");
  const description = clip(entry.description, maxDescription);
  return description ? `• ${header}\n  ${description}` : `• ${header}`;
}

function formatEducation(entry: EducationEntry) {
  const dates = formatDateRange(entry);
  return `• ${[entry.school, entry.degree, entry.field, dates]
    .filter(Boolean)
    .join(" · ")}`;
}

function formatDateRange(entry: {
  readonly current: boolean;
  readonly endMonth?: number;
  readonly endYear?: number;
  readonly startMonth?: number;
  readonly startYear?: number;
}) {
  const start = formatMonthYear(entry.startMonth, entry.startYear);
  const end = entry.current
    ? "present"
    : formatMonthYear(entry.endMonth, entry.endYear);
  if (start && end) return `${start}–${end}`;
  return start || end;
}

function formatMonthYear(month?: number, year?: number) {
  if (month === undefined || year === undefined) return "";
  return `${String(month).padStart(2, "0")}/${String(year)}`;
}

function clip(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}
