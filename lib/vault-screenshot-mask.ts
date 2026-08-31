/** Shared identity for the in-page vault-secret mask used by fill and capture. */
export const vaultScreenshotMaskStyleId = "vault-screenshot-mask";
const vaultScreenshotMaskSelector = '[data-vault-secret="true"]';

export const vaultScreenshotMaskCss = `${vaultScreenshotMaskSelector} { color: transparent !important; text-shadow: 0 0 8px black !important; -webkit-text-security: disc !important; }`;
