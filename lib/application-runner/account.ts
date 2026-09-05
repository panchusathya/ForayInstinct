import { z } from "zod";
import { readCandidateContactIdentity } from "@/db/services/candidate-profile";
import { applicationExecutionLog } from "@/lib/application-execution";
import {
  clickControl,
  type PageControl,
} from "@/lib/application-runner/navigate";
import {
  applyFillsCode,
  detectLoginWallCode,
} from "@/lib/application-runner/playwright-scripts";
import type { ApplicationRunInput } from "@/lib/application-runner/types";
import { tryFillLoginFromVault } from "@/lib/application-runner/vault";
import { browserProvider } from "@/lib/browser";
import {
  generatePassword,
  type PasswordPolicy,
} from "@/lib/manager/generated-password";
import { createVaultLogin } from "@/lib/manager/server/store";
import { readManagerVaultItems } from "@/lib/manager/server/vault";
import { serializeLoginVaultPayload } from "@/lib/manager/vault-payload";
import { applicationPauseMessage } from "@/lib/task-completion";

const namedControlSchema = z
  .object({ index: z.number().int().min(0), text: z.string() })
  .nullable()
  .default(null);

/** What the login-wall probe reports about the page. */
export const loginWallSchema = z.object({
  consents: z.array(z.string()).default([]),
  createControl: namedControlSchema,
  href: z.string().default(""),
  identifier: z
    .object({
      kind: z.enum(["email", "phone", "username"]),
      selector: z.string(),
    })
    .nullable()
    .default(null),
  loginWall: z.boolean(),
  passwords: z.array(z.string()).default([]),
  policyText: z.string().default(""),
  signInControl: namedControlSchema,
  wall: z.enum(["none", "register", "sign_in"]).default("none"),
});

export type LoginWall = z.infer<typeof loginWallSchema>;

type LoginWallInput = Pick<
  ApplicationRunInput,
  "applyUrl" | "executionId" | "scope"
> & { browserSessionId: string; wall: LoginWall };

export type LoginWallResult =
  | { passed: true; via: "created" | "sign_in" }
  | {
      applyUrl: string;
      message: string;
      pause: "user_input" | "vault_setup";
    };

/**
 * The password rules in the page's own words, as far as they can be read: a
 * minimum or maximum length and whether a symbol is demanded. Anything else
 * keeps the generator's defaults, which already satisfy the common policies.
 */
export function passwordPolicyFrom(text: string): PasswordPolicy {
  const policy: PasswordPolicy = {};
  const minimum =
    /(?:at least|minimum(?: of)?|min\.?|no fewer than)\s*(\d{1,2})\s*(?:characters|chars)?/iu.exec(
      text
    ) ?? /(\d{1,2})\s*(?:\+|or more)\s*(?:characters|chars)/iu.exec(text);
  const maximum =
    /(?:at most|maximum(?: of)?|max\.?|no more than|up to)\s*(\d{1,2})\s*(?:characters|chars)?/iu.exec(
      text
    );
  const between = /between\s*(\d{1,2})\s*(?:and|-|–)\s*(\d{1,2})/iu.exec(text);
  const clamp = (value: string) =>
    Math.min(64, Math.max(8, Number.parseInt(value, 10)));
  if (between?.[1] !== undefined && between[2] !== undefined) {
    policy.minLength = clamp(between[1]);
    policy.maxLength = clamp(between[2]);
  } else {
    if (minimum?.[1] !== undefined) policy.minLength = clamp(minimum[1]);
    if (maximum?.[1] !== undefined) policy.maxLength = clamp(maximum[1]);
  }
  if (
    policy.minLength !== undefined &&
    policy.maxLength !== undefined &&
    policy.maxLength < policy.minLength
  ) {
    delete policy.maxLength;
  }
  if (/symbol|special character|non-?alphanumeric/iu.test(text)) {
    policy.requireSymbol = true;
  }
  return policy;
}

/**
 * Gets past a page that wants an account before the application form.
 *
 * A sign-in page is filled from the vault when a login is saved; with none
 * saved, the page's own Create Account control is opened and the registration
 * page is handled instead. A registration page is filled with the candidate's
 * verified email and a password generated to the page's stated rules, saved
 * to the vault before anything is typed so a crash between the two never
 * leaves an account nobody can open. The only pause left is a page with no
 * registration path and no saved login, or a candidate with no verified
 * identifier to register with. Nothing typed here is ever logged.
 */
export async function passLoginWall(
  input: LoginWallInput,
  depth = 0
): Promise<LoginWallResult> {
  const { wall } = input;
  if (depth > 1 || wall.wall === "none") {
    return vaultSetupPause(input, `sign-in is required for ${input.applyUrl}.`);
  }
  if (wall.wall === "sign_in") {
    const vault = await tryFillLoginFromVault({
      browserSessionId: input.browserSessionId,
      scope: input.scope,
    }).catch(() => ({ filled: false, origin: input.applyUrl }));
    if (vault.filled) {
      if (wall.signInControl) {
        await clickControl(
          input.browserSessionId,
          asPageControl(wall.signInControl)
        );
      }
      applicationExecutionLog({
        apply_url: input.applyUrl,
        control: wall.signInControl?.text ?? "",
        event: "runner.signed_in",
        execution_id: input.executionId,
        origin: originOf(wall.href, input.applyUrl),
      });
      return { passed: true, via: "sign_in" };
    }
    if (wall.createControl) {
      const next = await switchWall(input, wall.createControl);
      if (next?.wall === "register") {
        return passLoginWall({ ...input, wall: next }, depth + 1);
      }
    }
    return vaultSetupPause(
      input,
      `sign-in is required for ${input.applyUrl}, no login is saved for it, and the page offers no way to create an account.`
    );
  }
  // A registration page while a login is already saved: the account exists,
  // so switch to signing in with it rather than registering twice.
  if (wall.signInControl && (await hasSavedLogin(input.scope))) {
    const next = await switchWall(input, wall.signInControl);
    if (next?.wall === "sign_in") {
      return passLoginWall({ ...input, wall: next }, depth + 1);
    }
  }
  return register(input);
}

async function register(input: LoginWallInput): Promise<LoginWallResult> {
  const { wall } = input;
  const origin = originOf(wall.href, input.applyUrl);
  if (!wall.identifier || wall.passwords.length === 0) {
    return vaultSetupPause(
      input,
      `${origin} wants an account, but I cannot find where the page takes the email address and password.`
    );
  }
  const identity = await readCandidateContactIdentity(input.scope);
  const kind = wall.identifier.kind === "phone" ? "phone" : "email";
  const identifier = kind === "phone" ? identity.phone : identity.email;
  if (identifier === undefined || identifier === "") {
    return vaultSetupPause(
      input,
      `${origin} wants an account, and I have no verified ${kind === "phone" ? "phone number" : "email address"} to register with.`
    );
  }
  // Saved first: the plaintext exists only in this frame, and a login that
  // reached the page but not the vault would be one nobody could sign in with.
  const password = generatePassword(passwordPolicyFrom(wall.policyText));
  await createVaultLogin(input.scope, {
    label: `${new URL(origin).hostname} application login`,
    secret: serializeLoginVaultPayload({
      authentication: { password, type: "password" },
      identifier: { type: kind, value: identifier },
      kind: "login",
      origin,
      version: 2,
    }),
  });
  const fills = [
    { selector: wall.identifier.selector, value: identifier },
    ...wall.passwords.map((selector) => ({ selector, value: password })),
    ...wall.consents.map((selector) => ({ selector, value: "yes" })),
  ];
  const applied = await browserProvider.executePlaywright(
    input.browserSessionId,
    { code: applyFillsCode(fills) }
  );
  const report = z
    .object({
      filled: z.array(z.string()).default([]),
      skipped: z
        .array(z.object({ reason: z.string(), selector: z.string() }))
        .default([]),
    })
    .safeParse(applied.result);
  const skipped = report.success ? report.data.skipped : [];
  for (const row of skipped) {
    applicationExecutionLog({
      event: "runner.fill_skipped",
      reason: row.reason.slice(0, 200),
      selector: row.selector,
    });
  }
  if (
    !report.success ||
    skipped.some((row) => wall.passwords.includes(row.selector))
  ) {
    return {
      applyUrl: input.applyUrl,
      message: applicationPauseMessage(
        "user_input",
        `${origin} wants an account, and the page would not take the password I typed. A login for it is saved; sign in there once and tell me when to continue.`
      ),
      pause: "user_input",
    };
  }
  const control = wall.createControl ?? wall.signInControl;
  const outcome = control
    ? await clickControl(input.browserSessionId, asPageControl(control))
    : undefined;
  applicationExecutionLog({
    apply_url: input.applyUrl,
    control: control?.text ?? "",
    errors: outcome?.errors.join(" | ") ?? "none",
    event: "runner.account_created",
    execution_id: input.executionId,
    moved: outcome?.navigated === true || (outcome?.heading ?? "") !== "",
    origin,
  });
  if (outcome && outcome.errors.length > 0) {
    return {
      applyUrl: input.applyUrl,
      message: applicationPauseMessage(
        "user_input",
        `${origin} would not create the account: ${outcome.errors.join("; ")}. A login for it is saved.`
      ),
      pause: "user_input",
    };
  }
  return { passed: true, via: "created" };
}

/** Opens the page's own link to the other kind of wall and reads it again. */
async function switchWall(
  input: LoginWallInput,
  control: NonNullable<LoginWall["createControl"]>
) {
  await clickControl(input.browserSessionId, asPageControl(control));
  const response = await browserProvider.executePlaywright(
    input.browserSessionId,
    { code: detectLoginWallCode }
  );
  const parsed = loginWallSchema.safeParse(response.result);
  return parsed.success ? parsed.data : undefined;
}

async function hasSavedLogin(scope: LoginWallInput["scope"]) {
  const items = await readManagerVaultItems(scope).catch(() => []);
  return items.some((item) => item.kind === "login" && item.hasSecret);
}

function asPageControl(
  control: NonNullable<LoginWall["createControl"]>
): PageControl {
  return {
    disabled: false,
    href: "",
    index: control.index,
    text: control.text,
  };
}

function originOf(href: string, fallback: string) {
  const source = URL.canParse(href) ? href : fallback;
  return URL.canParse(source) ? new URL(source).origin : fallback;
}

function vaultSetupPause(input: LoginWallInput, detail: string) {
  return {
    applyUrl: input.applyUrl,
    message: applicationPauseMessage("vault_setup", detail),
    pause: "vault_setup" as const,
  };
}
