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
  /**
   * A control the page hides from assistive technology is not one a candidate
   * is meant to touch. react-select keeps an invisible <input required
   * aria-hidden> beside every required select that has no value yet, purely so
   * the browser's constraint validation blocks the form; read as a field it is
   * an unlabelled required control nobody can answer, which is what the runner
   * kept reporting ten of.
   */
  const assistiveHidden = (node) => node.getAttribute("aria-hidden") === "true"
    || node.closest("[aria-hidden=true]") !== null;
  /**
   * A file input is nearly always hidden behind a styled button, and
   * setInputFiles works on it regardless, so it is the one control collected
   * whether or not it is drawn — and whether or not the page hides it from
   * assistive technology. The aria-hidden rule exists for react-select's
   * decoy required inputs; a file input is never one of those, and an ATS that
   * hides its real upload control behind an Attach button routinely marks it
   * aria-hidden too. Skipping it here is how a resume slot vanished from both
   * scans: nothing attached to it, nothing reported it blank, and the submit
   * came back "Resume/CV is required".
   */
  const isFileInput = (node) => node.tagName.toLowerCase() === "input"
    && String(node.getAttribute("type") || "").toLowerCase() === "file";
  const candidateFacing = (node) => isFileInput(node) || (!assistiveHidden(node) && visible(node));
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
  /**
   * Whether this node is the editable interior of a select-like widget rather
   * than the widget itself: some other element carries the combobox role for
   * it. Nothing broader. A react-select puts role=combobox on its typeahead
   * input, so that input IS the widget; a rule that skipped every input with
   * aria-autocomplete removed every dropdown on a Greenhouse form from both
   * scans at once, so nothing filled them and nothing reported them blank, and
   * the form went to the candidate for approval with all of them empty.
   */
  const isWidgetInterior = (node) => {
    const owner = node.closest("[role=combobox], [role=listbox]");
    return Boolean(owner && owner !== node);
  };
  /**
   * The placeholder a select-like widget shows while it has no value, if the
   * page names one. react-select describes its input by its placeholder
   * element exactly while nothing is chosen, so the element's presence is the
   * widget's own word that it is empty, and its text is what to discount when
   * reading the widget.
   */
  const describedPlaceholder = (node) => (node.getAttribute("aria-describedby") || "")
    .split(/\\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id))
    .find((element) => element && /placeholder/i.test(element.id));
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
      if (!candidateFacing(node)) return [];
      const tagName = node.tagName.toLowerCase();
      const role = (node.getAttribute("role") || "").toLowerCase();
      const type = (node.getAttribute("type") || tagName).toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "image") return [];
      // A widget's inner input is part of the combobox already collected, not
      // a field of its own. Counted separately it becomes a required control
      // with no label and nothing to ask about.
      if (isWidgetInterior(node)) return [];

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
      // really there, then decide. The click can be intercepted by the
      // placeholder painted over a typeahead's input, and a react-select opens
      // on ArrowDown just as well, so fall back to the keyboard rather than
      // wait out a thirty-second click on every such control.
      const clicked = await locator.click({ timeout: 4000 }).then(() => true).catch(() => false);
      if (!clicked) {
        await locator.focus().catch(() => undefined);
        await page.keyboard.press("ArrowDown").catch(() => undefined);
      }
      await page.waitForTimeout(150);
      const liveOptions = () => page.$$eval("[role=option]", (nodes) => nodes
        .filter((node) => {
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        })
        .map((node) => (node.innerText || node.textContent || "").trim())
        .filter(Boolean));
      const shown = await liveOptions();
      let live = shown;
      let wanted = matchOption(shown, wantedList(fill));
      // A typeahead offers nothing until something is typed: Greenhouse's
      // Location (City) is one, and it opened to an empty list on every run,
      // so the city never went anywhere and the question came back each time.
      // Type each phrasing into the widget's own input, wait for the
      // suggestions, and choose among them. A list that was already showing
      // choices is a closed set, where typing would only filter away the
      // options the caller needs to see.
      const box = tag === "input" ? locator : locator.locator("input").first();
      const typeahead = shown.length === 0 && (await box.count()) > 0;
      if (wanted === undefined && typeahead) {
        for (const value of wantedList(fill)) {
          await box.fill(value);
          const deadline = Date.now() + 2500;
          live = [];
          while (live.length === 0 && Date.now() < deadline) {
            await page.waitForTimeout(200);
            live = await liveOptions();
          }
          wanted = matchOption(live, [value]);
          if (wanted !== undefined) break;
        }
        // Leave the page as it was found: typed text a widget did not accept
        // is not a value, and it would read as one in a screenshot.
        if (wanted === undefined) await box.fill("").catch(() => undefined);
      }
      if (wanted === undefined) {
        await page.keyboard.press("Escape").catch(() => undefined);
        // Hand the real choices back so the caller can decide rather than
        // guess. A closed set is the one place a model can safely pick.
        offered.push({ options: shown.length > 0 ? shown : live, selector: fill.selector });
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
      if (!candidateFacing(node)) return [];
      const tagName = node.tagName.toLowerCase();
      const role = (node.getAttribute("role") || "").toLowerCase();
      const type = (node.getAttribute("type") || tagName).toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "image") return [];
      // A widget's inner input is part of the combobox already collected, not
      // a field of its own. Counted separately it becomes a required control
      // with no label and nothing to ask about.
      if (isWidgetInterior(node)) return [];
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
      } else if (type === "file") {
        blank = !(node.files && node.files.length > 0);
      } else if (role === "combobox" || role === "listbox") {
        // Whatever the widget shows once a choice is made. A react-select keeps
        // its typeahead input empty and paints the chosen option in a sibling,
        // so the input alone reads blank forever and the run stalls on a
        // question the candidate has already answered. Walk a few levels up
        // and treat any text other than the label or a placeholder as a choice.
        const own = (node.value || node.innerText || node.textContent || "").trim();
        const label = labelFor(node).replace(/\\s+/g, " ").trim();
        const placeholderNode = describedPlaceholder(node);
        const placeholders = [
          node.getAttribute("placeholder") || "",
          placeholderNode ? (placeholderNode.innerText || placeholderNode.textContent || "") : "",
        ].map((text) => text.replace(/\\s+/g, " ").trim()).filter(Boolean);
        let shown = "";
        let ancestor = node.parentElement;
        for (let depth = 0; ancestor && depth < 3 && shown === ""; depth += 1) {
          shown = (ancestor.innerText || "").replace(/\\s+/g, " ").trim();
          if (label && shown.startsWith(label)) shown = shown.slice(label.length).trim();
          ancestor = ancestor.parentElement;
        }
        const chosen = shown !== ""
          && !placeholders.includes(shown)
          && !/^(select|choose|please select)\\b[\\s.…]*(an? |one )?(option)?\\.{0,3}$/i.test(shown);
        // The widget pointing at its own placeholder outranks any text found
        // nearby: that is the page saying nothing is chosen.
        blank = own === "" && (placeholderNode !== undefined || !chosen);
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

/**
 * Puts the resume on the page's file control and proves it landed.
 *
 * The old script set the path on the scanned selector and returned; its
 * result was never read. Any one of three silent failures — a control the scan
 * missed, a staged path the browser's Playwright could not open, a page that
 * cleared the input — left the form without a resume and nothing in the log,
 * and the candidate found out from the ATS's own "Resume/CV is required".
 *
 * So this finds the control itself when the scanned selector is gone (any
 * file input whose wording says resume, else the only file input there is),
 * tries the staged path first, falls back to the file's own bytes when the
 * path cannot be read, and reads `files` back before claiming success. The
 * bytes travel base64-encoded inside the script and are decoded in the
 * browser VM; nothing about their contents is returned.
 */
export const attachFileCode = (input: {
  /** Base64 file bytes for when the staged path is unreadable. */
  payload?: { base64: string; mimeType: string; name: string };
  /** The staged browser-local path, when staging succeeded. */
  path?: string;
  /** The control the scan mapped the file to, if it saw one. */
  selector?: string;
}) => `
const wanted = /resume|\\bcv\\b|curriculum/i;
const scanned = ${JSON.stringify(input.selector ?? "")};
const stagedPath = ${JSON.stringify(input.path ?? "")};
const payload = ${JSON.stringify(input.payload ?? null)};
// What the control itself says it is for, then what the markup around it
// says. Kept apart: a wrapper's text can mention the resume next to a cover
// letter slot, so it only decides when no input names itself.
const describe = (node) => {
  const byFor = node.id && document.querySelector("label[for=" + JSON.stringify(node.id) + "]");
  const own = node.closest("label");
  const wrapper = node.closest("fieldset, [role=group], div");
  const tidy = (parts) => parts.filter(Boolean).join(" ").replace(/\\s+/g, " ").slice(0, 400);
  return {
    own: tidy([node.id, node.getAttribute("name"), node.getAttribute("aria-label"),
      byFor && byFor.innerText, own && own.innerText]),
    nearby: tidy([wrapper && wrapper.innerText]),
  };
};
let locator = scanned ? page.locator(scanned).first() : undefined;
let found = "scanned";
if (!locator || (await locator.count()) === 0
    || String(await locator.getAttribute("type").catch(() => "")).toLowerCase() !== "file") {
  // The scan's selector is gone or was not a file input: look for the control
  // by what the page says it is for, then settle for a lone file input.
  const inputs = page.locator("input[type=file]");
  const total = await inputs.count();
  const described = [];
  for (let i = 0; i < total; i += 1) described.push(await inputs.nth(i).evaluate(describe));
  locator = undefined;
  const byOwn = described.findIndex((text) => wanted.test(text.own));
  const byNearby = described.findIndex((text) => wanted.test(text.nearby));
  if (byOwn >= 0) { locator = inputs.nth(byOwn); found = "by-own-wording"; }
  else if (byNearby >= 0) { locator = inputs.nth(byNearby); found = "by-nearby-wording"; }
  else if (total === 1) { locator = inputs.first(); found = "only-file-input"; }
  if (!locator) return { ok: false, reason: "missing", fileInputs: total };
}
const attempts = [];
const attach = async (via, files) => {
  try {
    await locator.setInputFiles(files);
    return true;
  } catch (error) {
    attempts.push(via + ": " + String(error && error.message || error).slice(0, 160));
    return false;
  }
};
let via = "";
if (stagedPath && await attach("path", stagedPath)) via = "path";
if (!via && payload && await attach("payload", {
  name: payload.name,
  mimeType: payload.mimeType,
  buffer: Buffer.from(payload.base64, "base64"),
})) via = "payload";
if (!via) return { ok: false, reason: attempts.join(" | ") || "no file to attach", found };
// The page's own word, not the call's: a control can accept the call and
// hold nothing.
// The page's own word, not the call's. Either the control still holds the
// file, or the page has taken it: an ATS that uploads on change tends to
// clear the input straight after so the same file can be chosen again, and
// then shows the file's name once the upload lands. Reading the files list alone
// there called a successful attach a failure. Give the upload a moment, so a
// submit that follows is not refused mid-upload either.
const expected = payload ? payload.name : stagedPath.split("/").pop() || "";
const stem = expected.replace(/\\.[^.]+$/, "");
const check = async () => {
  const held = await locator.evaluate((node) => ({
    count: node.files ? node.files.length : 0,
    name: node.files && node.files[0] ? node.files[0].name : "",
  })).catch(() => ({ count: 0, name: "" }));
  const text = await page.locator("body").innerText().catch(() => "");
  const shown = expected !== "" && (text.includes(expected) || (stem.length > 3 && text.includes(stem)));
  return { held: held.count > 0, name: held.name || expected, shown };
};
const deadline = Date.now() + 6000;
let state = await check();
while (!state.shown && Date.now() < deadline) {
  await page.waitForTimeout(300);
  state = await check();
}
if (!state.held && !state.shown) {
  // Name the file inputs the page has, by their own wording only, so the
  // next reader of the log can see which control this was and what it was
  // labelled. Never the file, never a value.
  const inventory = await page.$$eval("input[type=file]", (nodes) => nodes.map((node) => {
    const byFor = node.id && document.querySelector("label[for=" + JSON.stringify(node.id) + "]");
    return [node.id, node.getAttribute("name"), byFor && byFor.innerText]
      .filter(Boolean).join(" ").replace(/\\s+/g, " ").slice(0, 80);
  }));
  return { ok: false, reason: "the control holds no file and the page shows no upload after setInputFiles", found, via, inventory };
}
return { ok: true, found, via, filename: state.name, shown: state.shown };
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
// The form's own submit control first. A posting page can carry other buttons
// whose names also say Apply, and taking the first name match means a click
// the runner reports as landed may have gone to a control that never submits
// anything: the DoorDash submit came back clicked, with no navigation and no
// error text, and the application was not in.
const candidates = [
  page.locator("form button[type=submit], form input[type=submit]"),
  page.getByRole("button", { name: /submit application|submit/i }),
  page.getByRole("button", { name: /apply|send application/i }),
];
let button;
for (const candidate of candidates) {
  const count = await candidate.count();
  for (let i = 0; i < count && !button; i += 1) {
    if (await candidate.nth(i).isVisible()) button = candidate.nth(i);
  }
  if (button) break;
}
if (!button) return { clicked: false, errors: [], href: before };
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
// The browser's own verdict on every control it validates. A form can refuse
// a submit with no message rendered anywhere, which is how a blocked submit
// came back reporting no errors at all: constraint validation had already
// stopped it before anything was drawn.
const invalid = await page.$$eval(
  "input, select, textarea",
  (nodes) => nodes
    .filter((node) => node.willValidate && !node.checkValidity())
    .map((node) => {
      const byFor = node.id && document.querySelector("label[for=" + JSON.stringify(node.id) + "]");
      const own = node.closest("label");
      const label = ((byFor && byFor.innerText) || (own && own.innerText) || node.getAttribute("aria-label") || node.getAttribute("name") || "")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, 120);
      const message = (node.validationMessage || "needs a value").trim();
      return label ? label + ": " + message : message;
    })
    .slice(0, 10)
).catch(() => []);
return { clicked: true, errors: [...new Set(errors)], href: page.url(), invalid: [...new Set(invalid)], navigated: page.url() !== before };
`;
