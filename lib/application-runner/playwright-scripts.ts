/** Playwright/TypeScript run against the hosted `page` global. */
export const collectVisibleFieldsCode = `
const fields = await page.$$eval("input, textarea, select", (nodes) => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const selectorFor = (node, index) => {
    if (node.id) return "#" + CSS.escape(node.id);
    const name = node.getAttribute("name");
    if (name) return node.tagName.toLowerCase() + "[name=" + JSON.stringify(name) + "]";
    return "(" + node.tagName.toLowerCase() + ")[" + String(index) + "]";
  };
  const labelFor = (node) => {
    const labelled = node.getAttribute("aria-label")
      || node.getAttribute("placeholder")
      || node.getAttribute("name")
      || "";
    if (node.id) {
      const byFor = document.querySelector("label[for=" + JSON.stringify(node.id) + "]");
      if (byFor) return (byFor.innerText || labelled).trim();
    }
    const parentLabel = node.closest("label");
    if (parentLabel) return (parentLabel.innerText || labelled).trim();
    return labelled.trim();
  };
  return nodes.flatMap((node, index) => {
    if (!visible(node)) return [];
    const type = (node.getAttribute("type") || node.tagName.toLowerCase()).toLowerCase();
    if (type === "hidden" || type === "submit" || type === "button" || type === "image") return [];
    return [{
      label: labelFor(node).slice(0, 200),
      name: node.getAttribute("name") || "",
      required: node.required === true || node.getAttribute("aria-required") === "true",
      selector: selectorFor(node, index),
      tag: type === "file" ? "file" : node.tagName.toLowerCase(),
      type,
    }];
  });
});
return { fields, href: page.url(), title: await page.title() };
`;

export const applyFillsCode = (
  fills: { selector: string; value: string }[]
) => `
const fills = ${JSON.stringify(fills)};
const filled = [];
const skipped = [];
for (const fill of fills) {
  const locator = page.locator(fill.selector).first();
  if (await locator.count() === 0) {
    skipped.push(fill.selector);
    continue;
  }
  const type = await locator.getAttribute("type");
  if ((type || "").toLowerCase() === "file") {
    skipped.push(fill.selector);
    continue;
  }
  const tag = await locator.evaluate((node) => node.tagName);
  if (tag === "SELECT") await locator.selectOption(fill.value).catch(() => locator.fill(fill.value));
  else await locator.fill(fill.value);
  filled.push(fill.selector);
}
return { filled, skipped, href: page.url() };
`;

export const setFileInputCode = (selector: string, path: string) => `
const locator = page.locator(${JSON.stringify(selector)}).first();
if (await locator.count() === 0) return { ok: false, reason: "missing" };
await locator.setInputFiles(${JSON.stringify(path)});
return { ok: true };
`;

export const detectLoginWallCode = `
const password = await page.locator("input[type=password]").count();
const text = String(await page.locator("body").innerText().catch(() => "")).toLowerCase();
const signIn = /sign in|log in|create account|register/.test(text);
return { loginWall: password > 0 && signIn, href: page.url() };
`;

export const clickSubmitCode = `
const button = page.getByRole("button", { name: /submit|apply|send application/i }).first();
if (await button.count() === 0) return { clicked: false };
await button.click();
return { clicked: true, href: page.url() };
`;
