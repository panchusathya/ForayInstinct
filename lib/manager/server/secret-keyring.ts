import { env } from "@/lib/env";
import {
  legacySecretKeyId,
  parseSecretEncryptionKeys,
  type SecretEncryptionKey,
} from "@/lib/secret-encryption-keys";

let cached:
  | {
      readonly byId: ReadonlyMap<string, SecretEncryptionKey>;
      readonly primary: SecretEncryptionKey;
    }
  | undefined;

/**
 * Every key this deployment can open a secret with, and the one it seals new
 * secrets with. The legacy key is always present under its reserved id, so a
 * keyring that lists only new keys still reads everything written before.
 */
export function secretKeyring() {
  if (cached) return cached;
  const legacy: SecretEncryptionKey = {
    id: legacySecretKeyId,
    key: Buffer.from(env.SECRET_ENCRYPTION_KEY, "base64"),
  };
  const configured =
    env.SECRET_ENCRYPTION_KEYS === undefined
      ? []
      : (parseSecretEncryptionKeys(env.SECRET_ENCRYPTION_KEYS) ?? []);
  cached = {
    byId: new Map([...configured, legacy].map((key) => [key.id, key])),
    primary: configured[0] ?? legacy,
  };
  return cached;
}
