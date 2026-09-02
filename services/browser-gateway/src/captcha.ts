/** Bright Data Captcha.setAutoSolve: keep solving, never auto-submit the form. */
export const captchaDisableAutoSubmitParams = {
  autoSolve: true,
  options: [
    { disabled: false, submit_form: false, type: "usercaptcha" },
    { disabled: false, submit_form: false, type: "hcaptcha" },
  ],
} as const;

export const captchaDisableAutoSubmitMethod = "Captcha.setAutoSolve";
