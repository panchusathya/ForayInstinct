import { kernel } from "@/lib/kernel";

export async function maskVaultFields(sessionId: string, signal?: AbortSignal) {
  const styleId = "vault-screenshot-mask";
  const selector = '[data-vault-secret="true"]';
  const addCode = `
for (const currentContext of browser.contexts()) {
  for (const currentPage of currentContext.pages()) {
    for (const frame of currentPage.frames()) {
      await frame.evaluate(({ styleId, selector }) => {
        if (document.getElementById(styleId)) return;
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = selector + " { color: transparent !important; text-shadow: 0 0 8px black !important; -webkit-text-security: disc !important; }";
        document.documentElement.append(style);
      }, ${JSON.stringify({ selector, styleId })}).catch(() => undefined);
    }
  }
}
return true;`;
  await kernel.browsers.playwright.execute(
    sessionId,
    { code: addCode, timeout_sec: 10 },
    { signal }
  );
  return async () => {
    const removeCode = `
for (const currentContext of browser.contexts()) {
  for (const currentPage of currentContext.pages()) {
    for (const frame of currentPage.frames()) {
      await frame.evaluate((styleId) => document.getElementById(styleId)?.remove(), ${JSON.stringify(styleId)}).catch(() => undefined);
    }
  }
}
return true;`;
    await kernel.browsers.playwright
      .execute(sessionId, { code: removeCode, timeout_sec: 10 }, { signal })
      .catch(() => undefined);
  };
}

export async function captureMaskedKernelScreenshot(
  sessionId: string,
  signal?: AbortSignal
) {
  const removeMask = await maskVaultFields(sessionId, signal);
  try {
    const response = await kernel.browsers.computer.captureScreenshot(
      sessionId,
      {},
      { signal }
    );
    return Buffer.from(await response.arrayBuffer());
  } finally {
    await removeMask();
  }
}
