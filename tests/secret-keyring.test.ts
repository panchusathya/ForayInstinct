import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const scope = { userId: "alice", workspaceId: "workspace:alice" };
const legacyKey = Buffer.alloc(32, 1);
const nextKey = Buffer.alloc(32, 2);

/** A `v1` envelope as every secret was written before rotation existed. */
function legacyEnvelope(id: string, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
  cipher.setAAD(Buffer.from([scope.workspaceId, "vault", id].join("\u0000")));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

async function loadStore() {
  vi.resetModules();
  return import("@/lib/manager/server/secret-store");
}

afterEach(() => {
  // The setup file stubs the rest of the environment; only the keyring is
  // this file's to change, so it is cleared rather than every stub undone.
  vi.stubEnv("SECRET_ENCRYPTION_KEYS", "");
});

describe("the secret keyring", () => {
  it("still opens a v1 envelope and seals new writes with a named key", async () => {
    const store = await loadStore();
    const legacy = legacyEnvelope("login-1", "hunter2");

    expect(
      store.canDecryptSecret({
        ciphertext: legacy,
        id: "login-1",
        namespace: "vault",
        scope,
      })
    ).toBe(true);
    const resealed = store.reencryptSecretForWorkspace({
      ciphertext: legacy,
      from: scope,
      id: "login-1",
      namespace: "vault",
      to: scope,
    });
    expect(resealed.startsWith("v2.v1.")).toBe(true);
    expect(
      store.canDecryptSecret({
        ciphertext: resealed,
        id: "login-1",
        namespace: "vault",
        scope,
      })
    ).toBe(true);
  });

  it("seals with the first listed key once a keyring is configured, and keeps reading the rest", async () => {
    vi.stubEnv("SECRET_ENCRYPTION_KEYS", `k2=${nextKey.toString("base64")}`);
    const store = await loadStore();
    const legacy = legacyEnvelope("login-1", "hunter2");

    const resealed = store.reencryptSecretForWorkspace({
      ciphertext: legacy,
      from: scope,
      id: "login-1",
      namespace: "vault",
      to: scope,
    });
    expect(resealed.startsWith("v2.k2.")).toBe(true);
    for (const ciphertext of [legacy, resealed]) {
      expect(
        store.canDecryptSecret({
          ciphertext,
          id: "login-1",
          namespace: "vault",
          scope,
        })
      ).toBe(true);
    }
  });

  it("refuses an envelope naming a key this deployment does not hold", async () => {
    const store = await loadStore();
    const legacy = legacyEnvelope("login-1", "hunter2");
    const resealed = store.reencryptSecretForWorkspace({
      ciphertext: legacy,
      from: scope,
      id: "login-1",
      namespace: "vault",
      to: scope,
    });
    const tampered = resealed.replace(/^v2\.v1\./u, "v2.zz.");

    expect(
      store.canDecryptSecret({
        ciphertext: tampered,
        id: "login-1",
        namespace: "vault",
        scope,
      })
    ).toBe(false);
    expect(
      store.canDecryptSecret({
        ciphertext: "v3.what.is.this",
        id: "login-1",
        namespace: "vault",
        scope,
      })
    ).toBe(false);
  });
});
