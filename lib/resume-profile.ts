import { generateText } from "ai";
import { z } from "zod";
import { browserLanguageModel } from "@/lib/model-config";
import {
  type CandidateProfile,
  type CandidateProfilePatch,
  profilePatchOf,
} from "@/lib/candidate-profile";

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

const instructions = [
  "Read this resume and return the candidate's details as JSON.",
  "Shape: { legalFirstName, legalLastName, contactEmail, headline, locationCity, locationRegion, locationCountryCode, linkedInUrl, workHistory: [{ company, title, startYear, endYear, current, location, description }] }.",
  "Omit any field the resume does not state. Never guess a value.",
  "Never infer work authorization, visa status, sponsorship, or anything about the candidate's legal right to work: a resume does not establish those.",
  "locationCountryCode is a two-letter ISO code. Years are four-digit numbers.",
  "Return only the JSON object.",
].join("\n");

/**
 * Reads a resume once so its facts stop being asked for one form field at a
 * time.
 *
 * A resume on file used to be uploadable but unreadable: nothing turned it
 * into the structured values a form fill needs, so a candidate with a complete
 * resume still got interrogated for their own name. This is the same model
 * already used for browser work, which accepts the document directly rather
 * than needing a PDF text extractor.
 */
export async function extractProfileFromResume(input: {
  bytes: Buffer;
  mimeType: string;
}): Promise<CandidateProfilePatch | undefined> {
  const { text } = await generateText({
    messages: [
      {
        content: [
          { text: instructions, type: "text" },
          {
            data: input.bytes,
            mediaType: input.mimeType,
            type: "file",
          },
        ],
        role: "user",
      },
    ],
    model: browserLanguageModel,
  });
  const parsed = extractedSchema.safeParse(parseJsonObject(text));
  if (!parsed.success) return undefined;
  return toProfilePatch(parsed.data);
}

/** Only fields the profile actually stores, and only where the resume spoke. */
function toProfilePatch(
  extracted: z.infer<typeof extractedSchema>
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
      { label: "LinkedIn", url: extracted.linkedInUrl.trim() },
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
