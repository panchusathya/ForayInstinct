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
 * itself, so declining alone never completes the page. The worker has no clock
 * and no profile of its own, so it is given the name and today's date to type
 * rather than being left to invent them.
 */
export function selfIdentificationSignature(name: string, today: Date) {
  const year = String(today.getUTCFullYear()).padStart(4, "0");
  const month = String(today.getUTCMonth() + 1).padStart(2, "0");
  const day = String(today.getUTCDate()).padStart(2, "0");

  return { day, isoDate: `${year}-${month}-${day}`, month, name, year };
}
