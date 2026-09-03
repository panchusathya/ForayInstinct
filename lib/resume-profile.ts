import { generateText } from "ai";
import { z } from "zod";
import { chatLanguageModel } from "@/lib/model-config";
import {
  type CandidateProfile,
  type CandidateProfilePatch,
  profilePatchOf,
} from "@/lib/candidate-profile";
import { extractDocumentText } from "@/lib/document-text";

/**
 * A stored resume as the extractor sees it. `extractedText` is what the
 * document store computed at upload; the bytes are only a fallback for a row
 * saved before that column existed or whose extraction failed at the time.
 */
export interface ResumeSource {
  readonly bytes?: Buffer;
  readonly extractedText?: string;
  readonly filename?: string;
  readonly mimeType?: string;
}

/**
 * What a resume can actually establish. Deliberately narrower than the full
 * profile: work authorization and sponsorship are legal status a resume does
 * not state, and guessing either would put a wrong answer on a real
 * application under the candidate's name.
 */
const extractedSchema = z.object({
  contactEmail: z.string().max(320).optional(),
  headline: z.string().max(200).optional(),
  legalFirstName: z.string().max(80).optional(),
  legalLastName: z.string().max(80).optional(),
  linkedInUrl: z.string().max(400).optional(),
  locationCity: z.string().max(120).optional(),
  locationCountryCode: z.string().max(8).optional(),
  locationRegion: z.string().max(120).optional(),
  workHistory: z
    .array(
      z.object({
        company: z.string().max(200),
        current: z.boolean().optional(),
        description: z.string().max(4_000).optional(),
        endYear: z.number().int().min(1900).max(2100).optional(),
        location: z.string().max(200).optional(),
        startYear: z.number().int().min(1900).max(2100).optional(),
        title: z.string().max(200),
      })
    )
    .max(30)
    .optional(),
});

type Extracted = z.infer<typeof extractedSchema>;

const instructions = [
  "Read this resume text and return the candidate's details as JSON.",
  "Shape: { legalFirstName, legalLastName, contactEmail, headline, locationCity, locationRegion, locationCountryCode, linkedInUrl, workHistory: [{ company, title, startYear, endYear, current, location, description }] }.",
  "Omit any field the resume does not state. Never guess a value.",
  "Never infer work authorization, visa status, sponsorship, or anything about the candidate's legal right to work: a resume does not establish those.",
  "locationCountryCode is a two-letter ISO code. Years are four-digit numbers.",
  "Return only the JSON object.",
].join("\n");

const emailPattern = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/iu;
const linkedInPattern =
  /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[\w%~-]+/iu;

/**
 * The text a resume has to offer, from the stored extraction or the bytes.
 * Empty when neither yields anything a person could read.
 */
export function resumeText(source: ResumeSource): string {
  const stored = source.extractedText?.trim() ?? "";
  const text =
    stored !== "" || !source.bytes
      ? stored
      : extractDocumentText(
          source.bytes,
          source.mimeType ?? "",
          source.filename ?? ""
        ).trim();
  // An extractor fed a scanned or encoded PDF returns glyph codes and
  // punctuation. That is not a resume anyone can read facts off.
  return /[a-z]{3,}/iu.test(text) ? text : "";
}

/**
 * The facts a resume states in a shape a regex can find exactly. These never
 * go through a model: an address or a profile URL is either on the page or it
 * is not, and a model can only make one up.
 */
export function resumeContactFacts(text: string): {
  contactEmail?: string;
  linkedInUrl?: string;
} {
  const email = emailPattern.exec(text)?.[0];
  const linkedIn = linkedInPattern.exec(text)?.[0];
  return {
    ...(email ? { contactEmail: email.toLowerCase() } : {}),
    ...(linkedIn ? { linkedInUrl: canonicalLinkedIn(linkedIn) } : {}),
  };
}

/** The regex facts alone as a profile patch, for a read that needs no model. */
export function contactFactsPatch(
  text: string
): CandidateProfilePatch | undefined {
  return toProfilePatch(resumeContactFacts(text));
}

/**
 * Reads a resume once so its facts stop being asked for one form field at a
 * time.
 *
 * A resume on file used to be uploadable but unreadable: nothing turned it
 * into the structured values a form fill needs, so a candidate with a complete
 * resume still got interrogated for their own name. The document is read as
 * text — the store already extracted it at upload — and handed to the text
 * model. Sending the file itself to the vision model through the gateway was
 * rejected on every call, which is why extraction silently never happened.
 *
 * Contact facts come from regexes and win over whatever the model reports.
 */
export async function extractProfileFromResume(
  source: ResumeSource
): Promise<CandidateProfilePatch | undefined> {
  const text = resumeText(source);
  if (text === "") return undefined;
  const exact = resumeContactFacts(text);
  const { text: reply } = await generateText({
    model: chatLanguageModel,
    prompt: `${instructions}\n\nResume text:\n${text}`,
  });
  const parsed = extractedSchema.safeParse(parseJsonObject(reply));
  return toProfilePatch({ ...(parsed.success ? parsed.data : {}), ...exact });
}

/** Only fields the profile actually stores, and only where the resume spoke. */
function toProfilePatch(
  extracted: Extracted
): CandidateProfilePatch | undefined {
  const patch: Record<string, unknown> = {};
  for (const key of [
    "contactEmail",
    "headline",
    "legalFirstName",
    "legalLastName",
    "locationCity",
    "locationCountryCode",
    "locationRegion",
  ] as const) {
    const value = extracted[key]?.trim();
    if (value) patch[key] = value;
  }
  if (extracted.linkedInUrl?.trim()) {
    patch.links = [
      { label: "LinkedIn", url: canonicalLinkedIn(extracted.linkedInUrl) },
    ] satisfies CandidateProfile["links"];
  }
  const workHistory = (extracted.workHistory ?? [])
    .filter((entry) => entry.company.trim() && entry.title.trim())
    .map((entry) => ({
      company: entry.company.trim(),
      current: entry.current ?? false,
      description: entry.description?.trim() ?? "",
      endYear: entry.endYear,
      location: entry.location?.trim() ?? "",
      startYear: entry.startYear,
      title: entry.title.trim(),
    }));
  if (workHistory.length > 0) patch.workHistory = workHistory;
  return profilePatchOf(patch);
}

/** A resume prints `linkedin.com/in/name`; a form wants the full URL. */
function canonicalLinkedIn(value: string) {
  const trimmed = value.trim().replace(/\/+$/u, "");
  return /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value;
  } catch {
    return {};
  }
}
