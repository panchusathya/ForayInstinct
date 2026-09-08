import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  deleteEncryptedSecret,
  readEncryptedSecret,
  writeEncryptedSecret,
  type SecretNamespace,
} from "@/db/services/secrets";
import type { AccessScope } from "../../access-scope";
import { legacySecretKeyId } from "@/lib/secret-encryption-keys";
import { secretKeyring } from "./secret-keyring";

export function secretStoreStatus() {
  return {
    available: true,
    description:
      "Secrets are encrypted for this workspace before database storage.",
    kind: "Encrypted vault",
  };
}

export async function writeSecret({
  id,
  namespace,
  scope,
  value,
}: {
  readonly id: string;
  readonly namespace: SecretNamespace;
  readonly scope: AccessScope;
  readonly value: string;
}) {
  await writeEncryptedSecret(
    scope,
    namespace,
    id,
    encryptSecret(scope, namespace, id, value)
  );
}

export async function readSecret({
  id,
  namespace,
  scope,
}: {
  readonly id: string;
  readonly namespace: SecretNamespace;
  readonly scope: AccessScope;
}) {
  const encrypted = await readEncryptedSecret(scope, namespace, id);
  if (!encrypted) return undefined;
  const value = decryptSecret(scope, namespace, id, encrypted);
  if (!sealedWithPrimary(encrypted)) {
    // Rotation happens as secrets are read: an envelope under a retired key
    // is written back under the current one, so the old key can be dropped
    // once every live secret has been touched. Not the reader's problem if
    // the write fails; the next read tries again.
    await writeEncryptedSecret(
      scope,
      namespace,
      id,
      encryptSecret(scope, namespace, id, value)
    ).catch(() => undefined);
  }
  return value;
}

export async function hasSecret({
  id,
  namespace,
  scope,
}: {
  readonly id: string;
  readonly namespace: SecretNamespace;
  readonly scope: AccessScope;
}) {
  return (await readEncryptedSecret(scope, namespace, id)) !== undefined;
}

export async function deleteSecret({
  id,
  namespace,
  scope,
}: {
  readonly id: string;
  readonly namespace: SecretNamespace;
  readonly scope: AccessScope;
}) {
  await deleteEncryptedSecret(scope, namespace, id);
}

/**
 * Seals with the keyring's primary key. The envelope names the key it was
 * sealed with (`v2.<kid>.<iv>.<tag>.<ciphertext>`); the `v1` envelopes that
 * came before carry no key id and always mean the legacy key.
 */
function encryptSecret(
  scope: AccessScope,
  namespace: SecretNamespace,
  id: string,
  value: string
) {
  const { primary } = secretKeyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", primary.key, iv);
  cipher.setAAD(secretAad(scope, namespace, id));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v2",
    primary.id,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Whether a stored envelope was sealed with the key new writes use. */
function sealedWithPrimary(value: string) {
  const [version, keyId] = value.split(".");
  return version === "v2" && keyId === secretKeyring().primary.id;
}

/** The key and parts an envelope names, or nothing for a shape we never wrote. */
function openEnvelope(value: string) {
  const parts = value.split(".");
  const [version] = parts;
  if (version === "v1" && parts.length === 4) {
    return {
      ciphertext: parts[3] ?? "",
      iv: parts[1] ?? "",
      keyId: legacySecretKeyId,
      tag: parts[2] ?? "",
    };
  }
  if (version === "v2" && parts.length === 5) {
    return {
      ciphertext: parts[4] ?? "",
      iv: parts[2] ?? "",
      keyId: parts[1] ?? "",
      tag: parts[3] ?? "",
    };
  }
  return undefined;
}

/**
 * Rebinds ciphertext to a new workspace AAD. Adopted vault rows used to copy
 * the bytes verbatim, so logins bound to the legacy workspace could not
 * decrypt after the move.
 */
export function reencryptSecretForWorkspace(input: {
  ciphertext: string;
  from: AccessScope;
  id: string;
  namespace: SecretNamespace;
  to: AccessScope;
}) {
  const plaintext = decryptSecret(
    input.from,
    input.namespace,
    input.id,
    input.ciphertext
  );
  return encryptSecret(input.to, input.namespace, input.id, plaintext);
}

/**
 * Whether this ciphertext opens under this scope's AAD. A row copied verbatim
 * from another workspace does not, and is worth replacing when the original
 * still can be read.
 */
export function canDecryptSecret(input: {
  ciphertext: string;
  id: string;
  namespace: SecretNamespace;
  scope: AccessScope;
}) {
  try {
    decryptSecret(input.scope, input.namespace, input.id, input.ciphertext);
    return true;
  } catch {
    return false;
  }
}

function decryptSecret(
  scope: AccessScope,
  namespace: SecretNamespace,
  id: string,
  value: string
) {
  const envelope = openEnvelope(value);
  if (!envelope?.iv || !envelope.tag || !envelope.ciphertext) {
    throw new Error("The stored secret uses an unsupported format.");
  }
  const key = secretKeyring().byId.get(envelope.keyId);
  if (!key) {
    throw new Error(
      "The stored secret was sealed with a key this deployment does not hold."
    );
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key.key,
    Buffer.from(envelope.iv, "base64url")
  );
  decipher.setAAD(secretAad(scope, namespace, id));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function secretAad(scope: AccessScope, namespace: SecretNamespace, id: string) {
  return Buffer.from([scope.workspaceId, namespace, id].join("\u0000"));
}
