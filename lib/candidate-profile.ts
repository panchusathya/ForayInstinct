import { z } from "zod";

/**
 * Structured facts the worker needs to complete an ATS profile wizard. This is
 * not the Better Auth user row and not EEO answers (those stay in
 * `settings.self_identification`). SSN, date of birth, government IDs,
 * references, and any password are excluded on purpose.
 */

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
  company: boundedText(200),
  current: z.boolean().default(false),
  description: boundedText(4_000),
  endMonth: monthSchema.optional(),
  endYear: yearSchema.optional(),
  location: boundedText(200),
  startMonth: monthSchema.optional(),
  startYear: yearSchema.optional(),
  title: boundedText(200),
});

const educationEntrySchema = z.object({
  current: z.boolean().default(false),
  degree: boundedText(200),
  endMonth: monthSchema.optional(),
  endYear: yearSchema.optional(),
  field: boundedText(200),
  school: boundedText(200),
  startMonth: monthSchema.optional(),
  startYear: yearSchema.optional(),
});

const profileLinkSchema = z.object({
  label: boundedText(80),
  url: boundedText(500),
});

const skillsSchema = z
  .array(z.string().trim().min(1).max(80))
  .max(40)
  .catch([]);
const linksSchema = z.array(profileLinkSchema).max(20).catch([]);
const workHistorySchema = z.array(workHistoryEntrySchema).max(30).catch([]);
const educationSchema = z.array(educationEntrySchema).max(20).catch([]);

export const candidateProfileSchema = z.object({
  earliestStartDate: boundedText(80),
  education: educationSchema,
  headline: boundedText(200),
  legalFirstName: boundedText(80),
  legalLastName: boundedText(80),
  links: linksSchema,
  locationCity: boundedText(120),
  locationCountryCode: boundedText(8),
  locationPostalCode: boundedText(20),
  locationRegion: boundedText(120),
  preferredName: boundedText(80),
  requiresSponsorshipFuture: yesNoBlankSchema.default(""),
  requiresSponsorshipNow: yesNoBlankSchema.default(""),
  salaryCurrency: boundedText(8).default("USD"),
  salaryMax: z.number().int().min(0).max(10_000_000).nullable().default(null),
  salaryMin: z.number().int().min(0).max(10_000_000).nullable().default(null),
  salaryPeriod: salaryPeriodSchema.default(""),
  skills: skillsSchema,
  summary: boundedText(8_000),
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

const candidateContactIdentitySchema = z.object({
  email: z.string().optional(),
  name: z.string(),
  phone: z.string().optional(),
});

export const candidateProfileResponseSchema = z.object({
  identity: candidateContactIdentitySchema,
  kernelProfileId: z.string(),
  profile: candidateProfileSchema,
});

export type CandidateContactIdentity = z.infer<
  typeof candidateContactIdentitySchema
>;
export type CandidateProfileResponse = z.infer<
  typeof candidateProfileResponseSchema
>;

const missingFieldChecks: readonly {
  readonly label: string;
  readonly missing: (profile: CandidateProfile) => boolean;
}[] = [
  {
    label: "legal first name",
    missing: (profile) => profile.legalFirstName.length === 0,
  },
  {
    label: "legal last name",
    missing: (profile) => profile.legalLastName.length === 0,
  },
  {
    label: "city",
    missing: (profile) => profile.locationCity.length === 0,
  },
  {
    label: "region / state",
    missing: (profile) => profile.locationRegion.length === 0,
  },
  {
    label: "country",
    missing: (profile) => profile.locationCountryCode.length === 0,
  },
  {
    label: "work authorization",
    missing: (profile) => profile.workAuthorization.length === 0,
  },
  {
    label: "sponsorship needed now",
    missing: (profile) => profile.requiresSponsorshipNow.length === 0,
  },
  {
    label: "sponsorship needed in the future",
    missing: (profile) => profile.requiresSponsorshipFuture.length === 0,
  },
  {
    label: "work history",
    missing: (profile) => profile.workHistory.length === 0,
  },
];

/** Human labels for facts an ATS wizard is likely to require and we do not have. */
export function missingProfileFields(profile: CandidateProfile): string[] {
  return missingFieldChecks
    .filter((field) => field.missing(profile))
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
