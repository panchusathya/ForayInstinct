import { readVaultItem } from "@/db/services/vault";
import type { AccessScope } from "@/lib/access-scope";
import { materializeAutofillClaims } from "@/lib/manager/server/vault-autofill";
import { vaultAutofillProvider } from "@/lib/manager/server/vault-autofill-provider";
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
  const items = await readManagerVaultItems(input.scope);
  const login = items.find((item) => item.kind === "login" && item.hasSecret);
  if (!login) return { filled: false, origin };
  const item = await readVaultItem(input.scope, login.id);
  if (item?.kind !== "login") return { filled: false, origin };
  const tokens = loginTokensForPurpose("sign_in");
  const claims = await materializeAutofillClaims(
    input.scope,
    login.id,
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
