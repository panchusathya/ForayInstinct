import { readVaultItem } from "@/db/services/vault";
import type { AccessScope } from "@/lib/access-scope";
import { readSecret } from "@/lib/manager/server/secret-store";
import { materializeAutofillClaims } from "@/lib/manager/server/vault-autofill";
import {
  isBoundLoginForOrigin,
  vaultAutofillProvider,
} from "@/lib/manager/server/vault-autofill-provider";
import { loginTokensForPurpose } from "@/lib/manager/server/kernel-login-autofill";
import {
  currentKernelPageOrigin,
  fillWithKernelNativeAutofill,
} from "@/lib/manager/server/kernel-native-autofill";
import { readManagerVaultItems } from "@/lib/manager/server/vault";

/**
 * CDP vault autofill lifted from the worker `fill_from_vault` tool. The runner
 * tries a bound login on a sign-in wall, then pauses for vault setup if none
 * exists.
 */
export async function tryFillLoginFromVault(input: {
  browserSessionId: string;
  scope: AccessScope;
  signal?: AbortSignal;
}): Promise<{ filled: boolean; origin: string }> {
  const origin = await currentKernelPageOrigin({
    browserSessionId: input.browserSessionId,
    signal: input.signal,
  });
  const loginId = await findLoginForOrigin(input.scope, origin);
  if (loginId === undefined) return { filled: false, origin };
  const item = await readVaultItem(input.scope, loginId);
  if (item?.kind !== "login") return { filled: false, origin };
  const tokens = loginTokensForPurpose("sign_in");
  const claims = await materializeAutofillClaims(
    input.scope,
    loginId,
    {
      availableTokens: new Set(tokens),
      origin,
      surface: {
        fields: tokens.map((token) => ({ score: 100, token })),
        id: "credentials",
        kind: "credentials",
      },
    },
    vaultAutofillProvider
  );
  await fillWithKernelNativeAutofill({
    browserSessionId: input.browserSessionId,
    claims,
    expectedOrigin: origin,
    kind: "login",
    purpose: "sign_in",
    signal: input.signal,
  });
  return { filled: true, origin };
}

/**
 * The saved login bound to this site, if any.
 *
 * The first login in the workspace used to be taken whatever site it was
 * for; the origin check downstream then refused it, and a candidate with one
 * Workday login could sign in nowhere else and register nowhere new. Each
 * login's payload names its origin, so that is what is matched. Payloads are
 * decrypted only to read that field and are never logged.
 */
export async function findLoginForOrigin(
  scope: AccessScope,
  origin: string
): Promise<string | undefined> {
  const items = await readManagerVaultItems(scope);
  for (const item of items) {
    if (item.kind !== "login" || !item.hasSecret) continue;
    const secret = await readSecret({
      id: item.id,
      namespace: "vault",
      scope,
    }).catch(() => undefined);
    if (typeof secret === "string" && isBoundLoginForOrigin(secret, origin)) {
      return item.id;
    }
  }
  return undefined;
}

export async function hasSavedLoginForOrigin(
  scope: AccessScope,
  origin: string
) {
  return (
    (await findLoginForOrigin(scope, origin).catch(() => undefined)) !==
    undefined
  );
}
