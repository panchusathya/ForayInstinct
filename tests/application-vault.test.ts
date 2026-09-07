import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeLoginVaultPayload } from "@/lib/manager/vault-payload";

const mocks = vi.hoisted(() => ({
  items:
    vi.fn<() => Promise<{ hasSecret: boolean; id: string; kind: string }[]>>(),
  readSecret:
    vi.fn<
      (_input: { id: string; namespace: string }) => Promise<string | undefined>
    >(),
}));

vi.mock("@/lib/manager/server/vault", () => ({
  readManagerVaultItems: mocks.items,
}));
vi.mock("@/lib/manager/server/secret-store", () => ({
  deleteSecret: vi.fn<() => Promise<void>>(async () => undefined),
  hasSecret: vi.fn<() => Promise<boolean>>(async () => true),
  readSecret: mocks.readSecret,
  reencryptSecretForWorkspace: vi.fn<() => string>(() => ""),
  secretStoreStatus: vi.fn<() => string>(() => "ready"),
  writeSecret: vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock("@/db/services/vault", () => ({
  createVaultItem: vi.fn<() => Promise<undefined>>(async () => undefined),
  deleteVaultItem: vi.fn<() => Promise<undefined>>(async () => undefined),
  listVaultItems: vi.fn<() => Promise<never[]>>(async () => []),
  readVaultItem: vi.fn<() => Promise<undefined>>(async () => undefined),
}));
vi.mock("@/lib/manager/server/vault-autofill", () => ({
  materializeAutofillClaims: vi.fn<() => Promise<never[]>>(async () => []),
}));
vi.mock("@/lib/manager/server/kernel-login-autofill", () => ({
  loginTokensForPurpose: vi.fn<() => string[]>(() => []),
}));
vi.mock("@/lib/manager/server/kernel-native-autofill", () => ({
  currentKernelPageOrigin: vi.fn<() => Promise<string>>(
    async () => "https://b.example"
  ),
  fillWithKernelNativeAutofill: vi.fn<() => Promise<void>>(
    async () => undefined
  ),
}));

import {
  findLoginForOrigin,
  hasSavedLoginForOrigin,
} from "@/lib/application-runner/vault";

const scope = { userId: "alice", workspaceId: "workspace:alice" };

const login = (origin: string) =>
  serializeLoginVaultPayload({
    authentication: { password: "hunter2-Hunter2!", type: "password" },
    identifier: { type: "email", value: "ada@example.com" },
    kind: "login",
    origin,
    version: 2,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.items.mockResolvedValue([
    { hasSecret: true, id: "login-a", kind: "login" },
    { hasSecret: true, id: "card-1", kind: "payment" },
    { hasSecret: true, id: "login-b", kind: "login" },
    { hasSecret: false, id: "login-empty", kind: "login" },
  ]);
  mocks.readSecret.mockImplementation(async ({ id }) =>
    id === "login-a"
      ? login("https://a.example")
      : id === "login-b"
        ? login("https://b.example")
        : undefined
  );
});

describe("the saved login for a site", () => {
  it("is the one whose payload names that origin, not the first in the vault", async () => {
    // The first login was taken whatever site it was for, and the origin
    // check downstream then refused it: one Workday login meant no other ATS
    // could be signed into or registered on.
    await expect(findLoginForOrigin(scope, "https://b.example")).resolves.toBe(
      "login-b"
    );
    await expect(findLoginForOrigin(scope, "https://a.example")).resolves.toBe(
      "login-a"
    );
    await expect(
      findLoginForOrigin(scope, "https://c.example")
    ).resolves.toBeUndefined();
    await expect(
      hasSavedLoginForOrigin(scope, "https://c.example")
    ).resolves.toBe(false);
    await expect(
      hasSavedLoginForOrigin(scope, "https://b.example")
    ).resolves.toBe(true);
  });

  it("only ever decrypts logins, and never one with no secret", async () => {
    await findLoginForOrigin(scope, "https://c.example");
    const read = mocks.readSecret.mock.calls.map((call) => call[0].id);
    expect(read).toEqual(["login-a", "login-b"]);
    expect(
      mocks.readSecret.mock.calls.every((call) => call[0].namespace === "vault")
    ).toBe(true);
  });

  it("never matches a legacy login that names no site", async () => {
    mocks.readSecret.mockResolvedValue(
      JSON.stringify({
        authentication: { password: "x", type: "password" },
        identifier: { type: "email", value: "ada@example.com" },
        kind: "login",
        version: 1,
      })
    );
    await expect(
      findLoginForOrigin(scope, "https://a.example")
    ).resolves.toBeUndefined();
  });
});
