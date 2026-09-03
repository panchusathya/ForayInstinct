/** Playwright/TypeScript run against the hosted `page` global. */

/**
 * Shared browser-side helpers. Inlined into each script because every script is
 * evaluated on its own — there is no module scope to hold them.
 */
const domHelpers = `
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
  /**
   * The control's own label only. An ancestor lookup would happily return a
   * neighbouring field's text, which then travels into every downstream
   * decision as if the page had said it.
   */
  const ownLabel = (node) => {
    // aria-labelledby names the label by id, so it is as precise as label[for]
    // and is how a React-rendered control usually carries its question. Without
    // it such a field reads as unlabelled and there is nothing to ask about.
    const labelledBy = node.getAttribute("aria-labelledby");
    if (labelledBy) {
      const named = labelledBy
        .split(/\\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((element) => (element.innerText || element.textContent || "").trim())
        .filter(Boolean)
        .join(" ");
      if (named) return named;
    }
    if (node.id) {
      const byFor = document.querySelector("label[for=" + JSON.stringify(node.id) + "]");
      if (byFor && byFor.innerText) return byFor.innerText.trim();
    }
    const parentLabel = node.closest("label");
    if (parentLabel && parentLabel.innerText) return parentLabel.innerText.trim();
    return "";
  };
  const labelFor = (node) => ownLabel(node)
    || (node.getAttribute("aria-label")
      || node.getAttribute("placeholder")
      || node.getAttribute("name")
      || "").trim();
  /**
   * An asterisk counts only inside the control's own label. Read from an
   * ancestor it matches the page's "* indicates a required field" note and
   * marks the whole form required.
   */
  const isRequired = (node) => node.required === true
    || node.getAttribute("aria-required") === "true"
    || /\\*/.test(ownLabel(node).slice(0, 200));
`;

/**
 * Collects the controls a candidate would have to touch by hand.
 *
 * Beyond plain text inputs this has to see the controls an ATS builds out of
 * markup rather than native elements: a `role=combobox` over a hidden select,
 * radio groups, and checkboxes. Those carry the questions that block a
 * submission — work authorization above all — and a control this misses is
 * worse than an unmapped one, because nothing downstream can report it.
 */
export const collectVisibleFieldsCode = `
const fields = await page.$$eval(
  "input, textarea, select, [role=combobox], [role=radiogroup], [role=listbox]",
  (nodes) => {
${domHelpers}
    const optionsFor = (node) => {
      const tag = node.tagName.toLowerCase();
      if (tag === "select") {
        return [...node.options].map((option) => (option.label || option.text || "").trim()).filter(Boolean);
      }
      const owned = node.getAttribute("aria-controls") || node.getAttribute("aria-owns");
      const listbox = (owned && document.getElementById(owned))
        || node.parentElement?.querySelector("[role=listbox]");
      if (listbox) {
        return [...listbox.querySelectorAll("[role=option]")]
          .map((option) => (option.innerText || "").trim())
          .filter(Boolean);
      }
      return [];
    };
    const seenRadioGroups = new Set();
    return nodes.flatMap((node, index) => {
      if (!visible(node)) return [];
      const tagName = node.tagName.toLowerCase();
      const role = (node.getAttribute("role") || "").toLowerCase();
      const type = (node.getAttribute("type") || tagName).toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "image") return [];
      // A combobox's inner typeahead input is part of the wrapper already
      // collected, not a field of its own. Counted separately it becomes a
      // required control with no label and nothing to ask about.
      const owner = node.closest("[role=combobox], [role=listbox]");
      if (owner && owner !== node) return [];

      // One entry per radio group, not per radio.
      if (type === "radio") {
        const name = node.getAttribute("name") || "";
        if (name && seenRadioGroups.has(name)) return [];
        if (name) seenRadioGroups.add(name);
        const peers = name
          ? [...document.querySelectorAll('input[type=radio][name=' + JSON.stringify(name) + ']')]
          : [node];
        const group = node.closest("fieldset, [role=radiogroup]");
        const groupLabel = group && group.querySelector("legend, label");
        return [{
          label: ((groupLabel && groupLabel.innerText) || labelFor(node)).slice(0, 200).trim(),
          name,
          options: peers.map((peer) => labelFor(peer)).filter(Boolean),
          required: peers.some((peer) => isRequired(peer)),
          selector: name ? 'input[type=radio][name=' + JSON.stringify(name) + ']' : selectorFor(node, index),
          tag: "radio",
          type: "radio",
        }];
      }

      const kind = role === "combobox" || role === "listbox"
        ? "combobox"
        : type === "file"
          ? "file"
          : type === "checkbox"
            ? "checkbox"
            : tagName;
      return [{
        label: labelFor(node).slice(0, 200),
        name: node.getAttribute("name") || "",
        options: optionsFor(node),
        required: isRequired(node),
        selector: selectorFor(node, index),
        tag: kind,
        type,
      }];
    });
  }
);
return { fields, href: page.url(), title: await page.title() };
`;

/**
 * Applies fills and reports exactly what took.
 *
 * Every control is attempted inside its own try/catch: one value an ATS will
 * not accept used to throw and abandon every remaining fill in the batch. The
 * `filled`/`skipped` split is the caller's only evidence that a value actually
 * landed, so it must always come back, even when the page fights it.
 */
export const applyFillsCode = (
  fills: { alternatives?: string[]; selector: string; value: string }[]
) => `
const fills = ${JSON.stringify(fills)};
const filled = [];
const skipped = [];
const offered = [];
// The value first, then any wording the profile knows means the same thing.
// A posting that asks "authorized to work?" offers Yes/No while the profile
// says "U.S. Citizen", so one string is rarely enough to match on.
const wantedList = (fill) => [fill.value, ...(fill.alternatives || [])]
  .map((value) => String(value).trim())
  .filter(Boolean);
const matchOption = (options, values) => {
  for (const value of values) {
    const wanted = value.toLowerCase();
    const exact = options.find((option) => option.trim().toLowerCase() === wanted);
    if (exact) return exact;
  }
  for (const value of values) {
    const wanted = value.toLowerCase();
    const partial = options.find((option) => {
      const text = option.trim().toLowerCase();
      return text.startsWith(wanted) || wanted.startsWith(text);
    });
    if (partial) return partial;
  }
  return undefined;
};
for (const fill of fills) {
  try {
    const locator = page.locator(fill.selector).first();
    if (await locator.count() === 0) {
      skipped.push({ reason: "missing", selector: fill.selector });
      continue;
    }
    const type = String(await locator.getAttribute("type") || "").toLowerCase();
    if (type === "file") {
      skipped.push({ reason: "file", selector: fill.selector });
      continue;
    }
    const role = String(await locator.getAttribute("role") || "").toLowerCase();
    const tag = String(await locator.evaluate((node) => node.tagName)).toLowerCase();

    if (type === "radio") {
      const group = page.locator(fill.selector);
      const count = await group.count();
      let checked = false;
      for (let i = 0; i < count; i += 1) {
        const option = group.nth(i);
        const text = await option.evaluate((node) => {
          const byFor = node.id && document.querySelector("label[for=" + JSON.stringify(node.id) + "]");
          const own = node.closest("label");
          return ((byFor && byFor.innerText) || (own && own.innerText) || node.value || "").trim();
        });
        const wanted = matchOption([String(text)], wantedList(fill));
        if (wanted !== undefined) {
          await option.check();
          checked = true;
          break;
        }
      }
      if (checked) filled.push(fill.selector);
      else skipped.push({ reason: "no-option", selector: fill.selector });
      continue;
    }

    if (type === "checkbox") {
      const on = /^(yes|true|1|on|checked)$/i.test(String(fill.value).trim());
      if (on) await locator.check();
      else await locator.uncheck();
      filled.push(fill.selector);
      continue;
    }

    if (tag === "select") {
      const options = await locator.evaluate((node) =>
        [...node.options].map((option) => (option.label || option.text || "").trim())
      );
      const wanted = matchOption(options, wantedList(fill));
      if (wanted === undefined) {
        offered.push({ options, selector: fill.selector });
        skipped.push({ reason: "no-option", selector: fill.selector });
        continue;
      }
      await locator.selectOption({ label: wanted });
      filled.push(fill.selector);
      continue;
    }

    if (role === "combobox" || role === "listbox") {
      // A react-select renders no listbox until it is opened, so its choices
      // cannot be read when the page is first scanned. Open it, read what is
      // really there, then decide.
      await locator.click();
      await page.waitForTimeout(150);
      const live = await page.$$eval("[role=option]", (nodes) => nodes
        .filter((node) => {
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        })
        .map((node) => (node.innerText || node.textContent || "").trim())
        .filter(Boolean));
      const wanted = matchOption(live, wantedList(fill));
      if (wanted === undefined) {
        await page.keyboard.press("Escape").catch(() => undefined);
        // Hand the real choices back so the caller can decide rather than
        // guess. A closed set is the one place a model can safely pick.
        offered.push({ options: live, selector: fill.selector });
        skipped.push({ reason: "no-option", selector: fill.selector });
        continue;
      }
      await page.getByRole("option", { name: wanted, exact: true }).first().click();
      filled.push(fill.selector);
      continue;
    }

    await locator.fill(fill.value);
    filled.push(fill.selector);
  } catch (error) {
    skipped.push({ reason: String(error && error.message || error).slice(0, 200), selector: fill.selector });
  }
}
return { filled, href: page.url(), offered, skipped };
`;

/**
 * Required controls the page still considers empty. This is ground truth after
 * a fill pass — trusting the fill's own report would miss a value the page
 * accepted and then cleared.
 */
export const collectEmptyRequiredFieldsCode = `
const empty = await page.$$eval(
  "input, textarea, select, [role=combobox], [role=listbox]",
  (nodes) => {
${domHelpers}
    const seenRadioGroups = new Set();
    return nodes.flatMap((node, index) => {
      if (!visible(node)) return [];
      const tagName = node.tagName.toLowerCase();
      const role = (node.getAttribute("role") || "").toLowerCase();
      const type = (node.getAttribute("type") || tagName).toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "image") return [];
      // A combobox's inner typeahead input is part of the wrapper already
      // collected, not a field of its own. Counted separately it becomes a
      // required control with no label and nothing to ask about.
      const owner = node.closest("[role=combobox], [role=listbox]");
      if (owner && owner !== node) return [];
      if (!isRequired(node)) return [];
      let blank;
      if (type === "radio") {
        const name = node.getAttribute("name") || "";
        if (name && seenRadioGroups.has(name)) return [];
        if (name) seenRadioGroups.add(name);
        const peers = name
          ? [...document.querySelectorAll('input[type=radio][name=' + JSON.stringify(name) + ']')]
          : [node];
        blank = !peers.some((peer) => peer.checked);
      } else if (type === "checkbox") {
        blank = node.checked !== true;
      } else if (role === "combobox" || role === "listbox") {
        // Whatever the widget shows once a choice is made. A react-select keeps
        // its typeahead input empty and paints the chosen option in a sibling,
        // so the input alone reads blank forever and the run stalls on a
        // question the candidate has already answered. Walk a few levels up
        // and treat any text other than the label or a placeholder as a choice.
        const own = (node.value || node.innerText || node.textContent || "").trim();
        const label = labelFor(node).replace(/\\s+/g, " ").trim();
        const placeholder = (node.getAttribute("placeholder") || "").trim();
        let shown = "";
        let ancestor = node.parentElement;
        for (let depth = 0; ancestor && depth < 3 && shown === ""; depth += 1) {
          shown = (ancestor.innerText || "").replace(/\\s+/g, " ").trim();
          if (label && shown.startsWith(label)) shown = shown.slice(label.length).trim();
          ancestor = ancestor.parentElement;
        }
        const chosen = shown !== ""
          && shown !== placeholder
          && !/^(select|choose|please select)\\b[\\s.…]*(an? |one )?(option)?\\.{0,3}$/i.test(shown);
        blank = own === "" && !chosen;
      } else {
        blank = String(node.value || "").trim() === "";
      }
      if (!blank) return [];
      const label = labelFor(node).slice(0, 200);
      // When nothing labels the control there is no question to put to the
      // candidate, so carry the surrounding form text instead. It is the
      // employer's own wording, never anything the candidate typed, and it is
      // what makes an unreadable field diagnosable without a screenshot.
      const wrapper = label === "" ? node.closest("fieldset, [role=group], div") : undefined;
      const nearby = wrapper ? (wrapper.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120) : "";
      return [{ label, nearby, selector: selectorFor(node, index), tag: (node.getAttribute("type") || node.tagName).toLowerCase() }];
    });
  }
);
return { empty, href: page.url() };
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

/**
 * Clicks submit and reports what the page did next.
 *
 * The click alone proves nothing: an ATS rejects an incomplete form in place,
 * leaving the URL untouched. Waiting for the page to settle and reading back
 * any validation text is what lets the caller tell a real submission from a
 * refused one.
 */
export const clickSubmitCode = `
const before = page.url();
const button = page.getByRole("button", { name: /submit|apply|send application/i }).first();
if (await button.count() === 0) return { clicked: false, errors: [], href: before };
await button.click();
await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
const errors = await page.$$eval(
  "[aria-invalid=true], [role=alert], .error, .field-error, [class*=error]",
  (nodes) => nodes
    .filter((node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.height > 0;
    })
    .map((node) => (node.innerText || node.getAttribute("aria-label") || "").trim())
    .filter((text) => text.length > 0 && text.length < 300)
    .slice(0, 10)
).catch(() => []);
return { clicked: true, errors: [...new Set(errors)], href: page.url(), navigated: page.url() !== before };
`;
