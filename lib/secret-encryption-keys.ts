/**
 * The rotation keyring, as `SECRET_ENCRYPTION_KEYS` spells it: comma-separated
 * `kid=base64` pairs, each a 32-byte key. The first pair seals new writes and
 * every pair still opens what it sealed. `SECRET_ENCRYPTION_KEY`, the key
 * every secret was written with before rotation existed, keeps the reserved
 * id below and is never listed here.
 */
export const legacySecretKeyId = "v1";

const keyIdPattern = /^[A-Za-z0-9_-]{1,32}$/u;

export interface SecretEncryptionKey {
  readonly id: string;
  readonly key: Buffer;
}

/** The parsed keyring, or nothing when any pair is malformed. */
export function parseSecretEncryptionKeys(
  value: string
): SecretEncryptionKey[] | undefined {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return undefined;
  const keys: SecretEncryptionKey[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) return undefined;
    const id = entry.slice(0, separator).trim();
    const key = Buffer.from(entry.slice(separator + 1).trim(), "base64");
    if (!keyIdPattern.test(id) || id === legacySecretKeyId || seen.has(id)) {
      return undefined;
    }
    if (key.length !== 32) return undefined;
    seen.add(id);
    keys.push({ id, key });
  }
  return keys;
}
