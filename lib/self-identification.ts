import { z } from "zod";

/**
 * Workday and most ATS platforms present these four voluntary
 * self-identification fields. They are optional by law and always offer a
 * decline option, so a missing answer is never a reason to stop an
 * application: an unset field is answered by declining, not by asking the
 * candidate mid-fill or by guessing from their name.
 */
export const selfIdentificationSchema = z.object({
  disabilityStatus: z.string().min(1).max(120).optional(),
  gender: z.string().min(1).max(80).optional(),
  raceEthnicity: z.string().min(1).max(120).optional(),
  veteranStatus: z.string().min(1).max(120).optional(),
});

export type SelfIdentification = z.infer<typeof selfIdentificationSchema>;

const selfIdentificationFields = [
  "disabilityStatus",
  "gender",
  "raceEthnicity",
  "veteranStatus",
] as const satisfies readonly (keyof SelfIdentification)[];

/** Fields the candidate has not answered, which the worker declines instead. */
export function declinedSelfIdentificationFields(
  answers: SelfIdentification
): string[] {
  return selfIdentificationFields.filter(
    (field) => answers[field] === undefined
  );
}

/**
 * The US federal disability form (CC-305) that Workday and other ATS platforms
 * render still requires a signature after the candidate declines the question
 * itself, so declining alone never completes the page. The browser date from
 * the Workday router is authoritative; this server date is the fallback when
 * that reading is missing. Pass an IANA time zone to format in that zone;
 * omit it to keep UTC.
 */
export function selfIdentificationSignature(
  name: string,
  today: Date,
  timeZone?: string
) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timeZone ?? "UTC",
    year: "numeric",
  }).formatToParts(today);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const day = pick("day");
  const month = pick("month");
  const year = pick("year");

  return { day, isoDate: `${year}-${month}-${day}`, month, name, year };
}
