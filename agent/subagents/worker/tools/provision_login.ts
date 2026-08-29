import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { ensureScope } from "@/db/services/scope";
import { readCandidateContactIdentity } from "@/db/services/candidate-profile";
import {
  generatePassword,
  passwordPolicySchema,
} from "@/lib/manager/generated-password";
import { currentKernelPageOrigin } from "@/lib/manager/server/kernel-native-autofill";
import { createVaultLogin } from "@/lib/manager/server/store";
import { vaultAutofillProvider } from "@/lib/manager/server/vault-autofill-provider";
import { loginIdentifierTypeSchema } from "@/lib/manager/vault-payload";
import { serializeLoginVaultPayload } from "@/lib/manager/vault-payload";

const credentialsSurface = {
  fields: [
    { score: 100, token: "username" },
    { score: 100, token: "email" },
    { score: 100, token: "tel" },
    { score: 100, token: "current-password" },
  ],
  id: "credentials",
  kind: "credentials",
} as const;

export default defineTool({
  description:
    'Create and vault a login for the current page origin so a signup form can be filled. Never supply origin, identifier, or password. Identifier type must be "email" or "phone" (a verified value from the candidate account); username registration is not supported. Returns an opaque handle only — never a secret. If a bound login already exists for this origin, returns that handle with created: false.',
  inputSchema: z.object({
    browser_session_id: z.string().trim().min(1).max(500),
    identifier_type: loginIdentifierTypeSchema,
    label: z.string().trim().min(1).max(120),
    password_policy: passwordPolicySchema.optional(),
  }),
  outputSchema: z.object({
    account: z.string(),
    created: z.boolean(),
    handle: z.string(),
    label: z.string(),
    origin: z.string(),
  }),
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.browser_session_id);
    await ensureScope(scope);

    const origin = await currentKernelPageOrigin({
      browserSessionId: input.browser_session_id,
      signal: context.abortSignal,
    });

    const existing = await vaultAutofillProvider.listSuggestions(
      scope,
      origin,
      credentialsSurface
    );
    const reuse = existing[0];
    if (reuse) {
      return {
        account: reuse.summary,
        created: false,
        handle: reuse.candidateId,
        label: reuse.label,
        origin,
      };
    }

    if (input.identifier_type === "username") {
      throw new Error(
        "Username registration is not supported. Provision an email or phone login, or return Needs user input: for a username the candidate must choose."
      );
    }

    const identity = await readCandidateContactIdentity(scope);
    const identifierValue =
      input.identifier_type === "email" ? identity.email : identity.phone;
    if (!identifierValue) {
      throw new Error(
        `The candidate has no verified ${input.identifier_type} to register with.`
      );
    }

    // Plaintext exists only inside this execute frame. Do not log the payload.
    const password = generatePassword(input.password_policy);
    const secret = serializeLoginVaultPayload({
      authentication: { password, type: "password" },
      identifier: {
        type: input.identifier_type,
        value: identifierValue,
      },
      kind: "login",
      origin,
      version: 2,
    });
    const created = await createVaultLogin(scope, {
      label: input.label,
      secret,
    });

    return {
      account: created.account,
      created: true,
      handle: created.id,
      label: created.label,
      origin,
    };
  },
});
