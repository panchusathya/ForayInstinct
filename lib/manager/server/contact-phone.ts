import { ensureScope } from "@/db/services/scope";
import type { AccessScope } from "@/lib/access-scope";
import { readSecret, writeSecret } from "@/lib/manager/server/secret-store";

const contactPhoneId = "phone";

/**
 * The candidate's own phone number, kept where the other personal values
 * are: encrypted per workspace, never in an id, a log, or a plain column.
 *
 * Over iMessage the workspace is keyed by a digest of the number and the
 * contact identity only ever carried a phone from a verified web account, so
 * a candidate who only ever texted had no phone on file: every posting asked
 * for it, and the answer was typed into the form and forgotten. The number a
 * candidate texts from is their number; an answer to a Phone question is too.
 */
export async function rememberContactPhone(scope: AccessScope, value: string) {
  const phone = normalizeContactPhone(value);
  if (phone === undefined) return;
  await ensureScope(scope);
  await writeSecret({
    id: contactPhoneId,
    namespace: "contact",
    scope,
    value: phone,
  });
}

export async function readContactPhone(
  scope: AccessScope
): Promise<string | undefined> {
  await ensureScope(scope);
  const stored = await readSecret({
    id: contactPhoneId,
    namespace: "contact",
    scope,
  });
  return stored === undefined ? undefined : normalizeContactPhone(stored);
}

/**
 * A phone number as a form will take it: the digits with one leading plus
 * kept, at least seven of them. Anything else is not a phone number and is
 * not stored.
 */
function normalizeContactPhone(value: string): string | undefined {
  const trimmed = value.trim();
  const plus = trimmed.startsWith("+") ? "+" : "";
  const digits = trimmed.replace(/\D+/gu, "");
  if (digits.length < 7 || digits.length > 15) return undefined;
  return `${plus}${digits}`;
}
