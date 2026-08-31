import type { AutofillClaim } from "../vault-autofill-protocol";

const nativeLoginPurposes = ["sign_in", "sign_up"] as const;
export type NativeLoginPurpose = (typeof nativeLoginPurposes)[number];

export const nativeLoginAutofillTokens = [
  "username",
  "email",
  "tel",
  "current-password",
  "new-password",
  "confirm-password",
] as const;

type NativeLoginAutofillToken = (typeof nativeLoginAutofillTokens)[number];

/** Leak boundary: sign-in never materializes new/confirm; sign-up never materializes current. */
export function loginTokensForPurpose(purpose: NativeLoginPurpose) {
  if (purpose === "sign_up") {
    return nativeLoginAutofillTokens.filter(
      (token) => token !== "current-password"
    );
  }
  return nativeLoginAutofillTokens.filter(
    (token) => token !== "new-password" && token !== "confirm-password"
  );
}

export interface NativeLoginControlDescriptor {
  readonly autocomplete: string;
  readonly automationId: string;
  readonly focused: boolean;
  readonly formIndex: number | null;
  readonly index: number;
  readonly label: string;
  readonly name: string;
  readonly type: string;
}

export interface ClassifiedNativeLoginControl extends NativeLoginControlDescriptor {
  readonly score: number;
  readonly token: NativeLoginAutofillToken;
}

export function classifyNativeLoginControl(
  descriptor: NativeLoginControlDescriptor,
  purpose: NativeLoginPurpose = "sign_in"
): ClassifiedNativeLoginControl | null {
  const autocompleteTokens = new Set(
    descriptor.autocomplete.toLowerCase().split(/\s+/u).filter(Boolean)
  );
  if (autocompleteTokens.has("one-time-code")) {
    return null;
  }
  if (autocompleteTokens.has("new-password")) {
    return purpose === "sign_up"
      ? { ...descriptor, score: 100, token: "new-password" }
      : null;
  }
  if (autocompleteTokens.has("current-password")) {
    return purpose === "sign_up"
      ? null
      : { ...descriptor, score: 100, token: "current-password" };
  }
  if (autocompleteTokens.has("confirm-password")) {
    return purpose === "sign_up"
      ? { ...descriptor, score: 100, token: "confirm-password" }
      : null;
  }

  for (const token of nativeLoginAutofillTokens) {
    if (isPasswordToken(token) || !autocompleteTokens.has(token)) continue;
    return { ...descriptor, score: 100, token };
  }

  const searchable = normalizeText(
    [descriptor.automationId, descriptor.name, descriptor.label]
      .filter(Boolean)
      .join(" ")
  );
  if (isConfirmPasswordControl(descriptor, searchable)) {
    return purpose === "sign_up"
      ? { ...descriptor, score: 95, token: "confirm-password" }
      : null;
  }
  if (descriptor.type === "password") {
    return purpose === "sign_up"
      ? { ...descriptor, score: 60, token: "new-password" }
      : { ...descriptor, score: 90, token: "current-password" };
  }
  if (descriptor.type === "email") {
    return { ...descriptor, score: 85, token: "email" };
  }
  if (descriptor.type === "tel") {
    return { ...descriptor, score: 85, token: "tel" };
  }
  if (/\b(?:e-?mail|email address)\b/u.test(searchable)) {
    return { ...descriptor, score: 75, token: "email" };
  }
  if (/\b(?:phone|telephone|mobile)\b/u.test(searchable)) {
    return { ...descriptor, score: 75, token: "tel" };
  }
  if (
    /\b(?:user\s*name|username|login|account|member|membership|mileageplus)\b/u.test(
      searchable
    )
  ) {
    return { ...descriptor, score: 70, token: "username" };
  }
  return null;
}

export function selectNativeLoginFills<T extends ClassifiedNativeLoginControl>(
  controls: readonly T[],
  claims: readonly Pick<AutofillClaim, "token" | "value">[],
  purpose: NativeLoginPurpose = "sign_in"
) {
  const values = new Map(claims.map(({ token, value }) => [token, value]));
  // Most hosted account forms do not autofocus a field. In that case, choose
  // the strongest visible field that can receive a saved identifier instead
  // of abandoning a safe, origin-bound autofill attempt.
  const focused =
    controls.find((control) => control.focused) ??
    controls
      .filter(
        (control) =>
          !isPasswordToken(control.token) &&
          (values.has(control.token) || values.has("username"))
      )
      .toSorted(compareLoginControls)[0] ??
    controls
      .filter(
        (control) => isPasswordToken(control.token) && values.has(control.token)
      )
      .toSorted(compareLoginControls)[0];
  if (!focused) return [];

  const sameSurface = controls
    .filter((control) => control.formIndex === focused.formIndex)
    .toSorted(compareLoginControls);
  const selected: { readonly control: T; readonly value: string }[] = [];

  const identifier = sameSurface.find(
    (control) =>
      !isPasswordToken(control.token) &&
      (values.has(control.token) || values.has("username"))
  );
  if (identifier) {
    const value = values.get(identifier.token) ?? values.get("username");
    if (value !== undefined) selected.push({ control: identifier, value });
  }

  if (purpose === "sign_up") {
    const passwordValue =
      values.get("new-password") ??
      values.get("confirm-password") ??
      values.get("current-password");
    if (passwordValue !== undefined) {
      for (const control of sameSurface) {
        if (isPasswordToken(control.token)) {
          selected.push({ control, value: passwordValue });
        }
      }
    }
    return selected;
  }

  const password = sameSurface.find(
    (control) =>
      control.token === "current-password" && values.has(control.token)
  );
  if (password) {
    const value = values.get(password.token);
    if (value !== undefined) selected.push({ control: password, value });
  }
  return selected;
}

export const nativeLoginControlInspectionExpression = `(() => {
  const elements = Array.from(document.querySelectorAll("input"));
  const forms = Array.from(document.forms);
  return elements.flatMap((element, index) => {
    if (element.disabled || element.readOnly) return [];
    if (["hidden", "submit", "button", "reset", "file", "image", "checkbox", "radio"].includes(element.type)) return [];
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) return [];
    const labels = element.labels ? Array.from(element.labels, (label) => label.textContent || "") : [];
    const ariaText = (element.getAttribute("aria-labelledby") || "")
      .split(/\\s+/u)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
    const resolvedFormIndex = element.form ? forms.indexOf(element.form) : -1;
    return [{
      autocomplete: element.autocomplete || "",
      automationId: element.getAttribute("data-automation-id") || "",
      focused: document.activeElement === element,
      formIndex: resolvedFormIndex >= 0 ? resolvedFormIndex : null,
      index,
      label: [
        ...labels,
        element.getAttribute("aria-label") || "",
        ariaText,
        element.getAttribute("placeholder") || "",
        element.getAttribute("title") || "",
      ].join(" "),
      name: [element.name, element.id].join(" "),
      type: element.type || "",
    }];
  });
})()`;

export const nativeLoginFillFunctionDeclaration = `function(value) {
  if (!(this instanceof HTMLInputElement)) return false;
  this.dataset.vaultSecret = "true";
  this.click();
  this.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return false;
  setter.call(this, value);
  this.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return this.value.length > 0;
}`;

function isPasswordToken(
  token: NativeLoginAutofillToken
): token is "current-password" | "new-password" | "confirm-password" {
  return (
    token === "current-password" ||
    token === "new-password" ||
    token === "confirm-password"
  );
}

function isConfirmPasswordControl(
  descriptor: NativeLoginControlDescriptor,
  searchable: string
) {
  if (
    /^(?:verifyPassword|verifyNewPassword|newPassword|confirmPassword)$/i.test(
      descriptor.automationId
    )
  ) {
    return true;
  }
  return /\b(?:new|confirm|create|repeat|verify)\s*password\b/u.test(
    searchable
  );
}

function compareLoginControls(
  left: ClassifiedNativeLoginControl,
  right: ClassifiedNativeLoginControl
) {
  if (left.focused !== right.focused) return left.focused ? -1 : 1;
  if (left.score !== right.score) return right.score - left.score;
  return left.index - right.index;
}

function normalizeText(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
}
