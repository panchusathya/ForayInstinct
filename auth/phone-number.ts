/**
 * One rule for what a phone number is, shared by sign-in, the workspace
 * scope it keys, and the contact number typed into forms. Seven to fifteen
 * digits after the country code, as the scope digest has always accepted.
 */
const E164_PHONE_NUMBER = /^\+[1-9]\d{6,14}$/;
const PHONE_NUMBER_INPUT = /^\+?[\d\s().-]+$/;

export function isE164PhoneNumber(value: string) {
  return E164_PHONE_NUMBER.test(value);
}

/**
 * The number in E.164, or nothing when it cannot be read as one. A leading
 * plus is taken as written; eleven digits starting with 1, or exactly ten,
 * are a North American number. Anything else without a country code is not
 * guessed at: the old rule put +1 in front of a UK number, and that value
 * became both the candidate's workspace key and the phone typed into forms.
 */
export function normalizeAuthPhoneNumber(value: string) {
  const trimmedValue = value.trim();
  if (!PHONE_NUMBER_INPUT.test(trimmedValue)) return;

  const digits = trimmedValue.replace(/\D/g, "");
  const normalizedValue = trimmedValue.startsWith("+")
    ? `+${digits}`
    : digits.length === 11 && digits.startsWith("1")
      ? `+${digits}`
      : digits.length === 10
        ? `+1${digits}`
        : undefined;

  return normalizedValue !== undefined && isE164PhoneNumber(normalizedValue)
    ? normalizedValue
    : undefined;
}

/**
 * The rule this replaced, kept only so a workspace keyed by its reading can
 * be found and adopted into the corrected one. Never use it for a new key.
 */
export function legacyNormalizeAuthPhoneNumber(value: string) {
  const trimmedValue = value.trim();
  if (!PHONE_NUMBER_INPUT.test(trimmedValue)) return;
  const digits = trimmedValue.replace(/\D/g, "");
  const normalizedValue = trimmedValue.startsWith("+")
    ? `+${digits}`
    : digits.length === 11 && digits.startsWith("1")
      ? `+${digits}`
      : `+1${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(normalizedValue)
    ? normalizedValue
    : undefined;
}
