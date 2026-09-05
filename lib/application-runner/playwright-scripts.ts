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

    if (type === "tel") {
      // A formatted phone widget reshapes the value on every keystroke and
      // can drop one written in a single stroke. Type it as a person would.
      await locator.click({ timeout: 4000 }).catch(() => undefined);
      await locator.fill("");
      await locator.pressSequentially(fill.value, { delay: 20 });
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
 * Three ways in, tried in the caller's order and each checked against the
 * control before the next is tried:
 *
 * - `path`: the staged file by its path. Right only where the Playwright code
 *   runs on the browser's own machine (Kernel). Over a plain CDP connection
 *   (the Brightdata gateway) Chromium resolves the path on *its* machine, the
 *   file is not there, and the call returns cleanly having attached nothing.
 *   That is the whole story of the resume that never reached DoorDash.
 * - `payload`: the bytes themselves; Playwright builds the File inside the
 *   page, so no filesystem is involved. Right on the gateway.
 * - `dom`: last resort with no Playwright file plumbing at all: a File built
 *   in the page from the base64, handed to the input through a DataTransfer,
 *   and announced with input and change events.
 *
 * Every remote call carries its own short timeout, so a hung browser produces
 * a caught error and a returned result rather than a gateway timeout with
 * nothing in it. The bytes travel base64-encoded inside the script and are
 * decoded in the browser VM; nothing about their contents is returned.
 */
export const attachFileCode = (input: {
  /** Which routes to try, first to last. */
  order: ("path" | "payload")[];
  /** Base64 file bytes, for the payload and dom routes. */
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
const order = ${JSON.stringify(input.order)};
const brief = { timeout: 2000 };
const describeError = (error) => String(error && error.message || error).replace(/\\s+/g, " ").slice(0, 160);
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
// By their own wording only, so a failure names the control and never the file.
const inventory = () => page.$$eval("input[type=file]", (nodes) => nodes.map((node) => {
  const byFor = node.id && document.querySelector("label[for=" + JSON.stringify(node.id) + "]");
  return [node.id, node.getAttribute("name"), byFor && byFor.innerText]
    .filter(Boolean).join(" ").replace(/\\s+/g, " ").slice(0, 80);
})).catch(() => []);
// A slot that says it is for some other document is never the resume's by
// default; only its own wording saying resume can make it so.
const otherDocument = /cover ?letter|portfolio|transcript|writing ?sample|reference|certificat|other (?:file|document)/i;
// The page's own word, not the call's. Either the control still holds the
// file, or the page has taken it: an ATS that uploads on change tends to
// clear the input straight after so the same file can be chosen again, and
// then shows the file's name once the upload lands.
const expected = payload ? payload.name : stagedPath.split("/").pop() || "";
const stem = expected.replace(/\\.[^.]+$/, "");
const shownOnPage = async () => {
  const text = await page.locator("body").innerText(brief).catch(() => "");
  return expected !== "" && (text.includes(expected) || (stem.length > 3 && text.includes(stem)));
};
// Every fill round runs this again. Once the page has taken the file it shows
// the name and removes the input, and the next scan's lone file input is
// whatever slot is left, which on Greenhouse is the cover letter. Attached
// already is done, not a slot to go looking for.
if (await shownOnPage()) return { ok: true, found: "already-attached", via: "already-attached", filename: expected, shown: true, attempts: [] };
let locator = scanned ? page.locator(scanned).first() : undefined;
let found = "scanned";
if (!locator || (await locator.count()) === 0
    || String(await locator.getAttribute("type", brief).catch(() => "")).toLowerCase() !== "file") {
  // The scan's selector is gone or was not a file input: look for the control
  // by what the page says it is for, then settle for a lone file input.
  const inputs = page.locator("input[type=file]");
  const total = await inputs.count();
  const described = [];
  for (let i = 0; i < total; i += 1) {
    described.push(await inputs.nth(i).evaluate(describe, undefined, brief).catch(() => ({ own: "", nearby: "" })));
  }
  locator = undefined;
  const byOwn = described.findIndex((text) => wanted.test(text.own));
  const byNearby = described.findIndex((text) => wanted.test(text.nearby) && !otherDocument.test(text.own));
  if (byOwn >= 0) { locator = inputs.nth(byOwn); found = "by-own-wording"; }
  else if (byNearby >= 0) { locator = inputs.nth(byNearby); found = "by-nearby-wording"; }
  else if (total === 1 && !otherDocument.test(described[0].own)) { locator = inputs.first(); found = "only-file-input"; }
  if (!locator) return { ok: false, reason: "missing", fileInputs: total };
}
const held = () => locator.evaluate((node) => ({
  count: node.files ? node.files.length : 0,
  name: node.files && node.files[0] ? node.files[0].name : "",
}), undefined, brief).catch(() => ({ count: 0, name: "" }));
// Whether a route that the browser accepted actually left a file behind: a
// path the browser's machine cannot see arrives as no file at all, without a
// word of complaint, and the next route has to be tried.
const landed = async () => {
  const until = Date.now() + 1500;
  for (;;) {
    if ((await held()).count > 0 || await shownOnPage()) return true;
    if (Date.now() >= until) return false;
    await page.waitForTimeout(250);
  }
};
const attempts = [];
const attach = async (via, files) => {
  try {
    await locator.setInputFiles(files, { timeout: 8000 });
  } catch (error) {
    attempts.push(via + ": " + describeError(error));
    return false;
  }
  if (await landed()) return true;
  attempts.push(via + ": accepted but the control holds no file");
  return false;
};
const domAttach = async () => {
  try {
    await locator.evaluate((node, file) => {
      const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
      node.files = transfer.files;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }, payload, { timeout: 8000 });
  } catch (error) {
    attempts.push("dom: " + describeError(error));
    return false;
  }
  if (await landed()) return true;
  attempts.push("dom: accepted but the control holds no file");
  return false;
};
let via = "";
for (const method of order) {
  if (via) break;
  if (method === "path" && stagedPath && await attach("path", stagedPath)) via = "path";
  if (method === "payload" && payload && await attach("payload", {
    name: payload.name,
    mimeType: payload.mimeType,
    buffer: Buffer.from(payload.base64, "base64"),
  })) via = "payload";
}
if (!via && payload && await domAttach()) via = "dom";
if (!via) {
  return {
    ok: false,
    reason: attempts.join(" | ") || "no file to attach",
    found,
    inventory: await inventory(),
  };
}
// Give a background upload a moment to land, so a submit that follows is not
// refused mid-upload. The file is already on the control either way.
const deadline = Date.now() + 6000;
let shown = await shownOnPage();
while (!shown && Date.now() < deadline) {
  await page.waitForTimeout(300);
  shown = await shownOnPage();
}
const state = await held();
return { ok: true, found, via, filename: state.name || expected, shown, attempts };
`;

/**
 * Browser-side helpers for a verification-code dialog, inlined into each
 * script that reads one: there is no module scope across scripts.
 *
 * A code input is one that says so in its attributes, or one of a cluster of
 * three or more small single-character boxes: Greenhouse's are
 * `#security-input-1` to `-7`, `type=text`, no label, no autocomplete, and
 * nothing in their attributes says code. Either way the wording around it
 * has to say verification too; a zip code is numeric and a posting can
 * mention verifying, and neither alone is a code dialog.
 */
const codeInputHelpers = `
  const visible = (node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const codeContext = /verif(?:y|ication)|one[- ]?time|security code|passcode|enter (?:the|your) code|code (?:we |was |has been )?sent|sent (?:you |a )?(?:code|email)|two[- ]?(?:factor|step)|authentication code|confirm your email/i;
  const skipTypes = new Set(["hidden", "submit", "button", "checkbox", "radio", "file", "email", "tel", "password", "search", "url"]);
  const singleBox = (node) => String(node.getAttribute("maxlength") || "") === "1" || node.getBoundingClientRect().width < 60;
  const inCluster = (node) => {
    const group = (node.parentElement && node.parentElement.parentElement) || node.parentElement;
    if (!group) return false;
    return [...group.querySelectorAll("input")].filter((peer) => visible(peer) && singleBox(peer)).length >= 3;
  };
  const codeLike = (node) => {
    const attrs = ["autocomplete", "name", "id", "placeholder", "aria-label", "inputmode"]
      .map((name) => node.getAttribute(name) || "").join(" ").toLowerCase();
    return /one-time-code|otp|verif|passcode|\\bcode\\b|numeric|\\bpin\\b|security|token|digit/.test(attrs) || inCluster(node);
  };
  const contextOf = (node) => node.closest("[role=dialog], dialog, form, section, main") || document.body;
  const codeInputs = () => [...document.querySelectorAll("input")].filter((node) =>
    visible(node)
    && !skipTypes.has(String(node.type || "").toLowerCase())
    && codeLike(node)
    && codeContext.test((contextOf(node).innerText || "").slice(0, 3000)));
`;

/**
 * Whether the page is asking for a verification code, and through which
 * channel. Returns the page's words, never any value: the channel, how many
 * boxes, and the sentence that asked.
 */
export const verificationCodeProbeCode = `
const found = await page.evaluate(() => {
${codeInputHelpers}
  const inputs = codeInputs();
  if (inputs.length === 0) return { present: false };
  const text = (contextOf(inputs[0]).innerText || "").replace(/\\s+/g, " ").trim();
  const sentence = (text.match(/[^.!?]*(?:code|verif)[^.!?]*[.!?]?/i) || [""])[0].trim().slice(0, 200);
  const channel = /\\b(?:sms|text message|phone|mobile)\\b/i.test(sentence) && !/e-?mail|inbox/i.test(sentence)
    ? "sms"
    : "email";
  return {
    present: true,
    channel,
    count: inputs.length,
    boxes: inputs.length > 1 && inputs.every(singleBox),
    prompt: sentence,
  };
});
const source = /greenhouse/i.test(new URL(page.url()).hostname) ? "Greenhouse" : new URL(page.url()).hostname;
return { ...found, hint: source, href: page.url() };
`;

/**
 * Types a verification code into the page and moves the page on.
 *
 * One box or one box per character; a Verify/Confirm/Submit/Continue button
 * in the same dialog or form, else Enter. Reports the page's own answer: the
 * visible error text, whether a code box is still asked for, and whether the
 * page now reads as a confirmation. The code itself never comes back.
 */
export const enterVerificationCodeCode = (code: string) => `
const code = ${JSON.stringify(code)};
const located = await page.evaluate(() => {
${codeInputHelpers}
  const all = [...document.querySelectorAll("input")];
  const inputs = codeInputs();
  return {
    indices: inputs.map((node) => all.indexOf(node)),
    boxes: inputs.length > 1 && inputs.every(singleBox),
  };
});
if (located.indices.length === 0) return { entered: false, clicked: false, confirmed: false, errors: [], remaining: 0, href: page.url() };
const first = page.locator("input").nth(located.indices[0]);
let entered = false;
try {
  if (located.boxes) {
    await first.click({ timeout: 4000 });
    await page.keyboard.type(code, { delay: 40 });
  } else {
    await first.fill(code, { timeout: 4000 });
  }
  entered = true;
} catch (error) {
  return { entered: false, clicked: false, confirmed: false, errors: [String(error && error.message || error).slice(0, 200)], remaining: located.indices.length, href: page.url() };
}
// The dialog's own button first, then any such button, then Enter. A box
// dialog often submits itself on the last character, so a button that has
// gone is not a failure.
const scope = first.locator("xpath=ancestor::*[@role='dialog' or self::dialog or self::form][1]");
const inScope = (await scope.count().catch(() => 0)) > 0 ? scope : page;
const button = inScope.getByRole("button", { name: /verify|confirm|submit|continue|next|done/i }).filter({ visible: true }).first();
let clicked = false;
if ((await button.count().catch(() => 0)) > 0) {
  clicked = await button.click({ timeout: 4000 }).then(() => true).catch(() => false);
}
if (!clicked) await page.keyboard.press("Enter").catch(() => undefined);
await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
await page.waitForTimeout(500);
const errors = await page.$$eval(
  "[role=alert], [aria-invalid=true], .error, .field-error, [class*=error]",
  (nodes) => nodes
    .filter((node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.height > 0;
    })
    .map((node) => (node.innerText || node.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim())
    .filter((text) => text.length > 0 && text.length < 300)
    .slice(0, 5)
).catch(() => []);
const after = await page.evaluate(() => {
${codeInputHelpers}
  const remaining = codeInputs().length;
  const text = (document.body.innerText || "").replace(/\\s+/g, " ");
  const confirmed = /thank you for applying|application (?:has been |was )?(?:submitted|received)|we(?:'ve| have) received your application|successfully submitted/i.test(text);
  return { remaining, confirmed };
}).catch(() => ({ remaining: 0, confirmed: false }));
return { entered, clicked, confirmed: after.confirmed, errors, remaining: after.remaining, href: page.url() };
`;

/**
 * Gets from a posting's description page to its application form.
 *
 * A posting URL often lands on the description with an Apply button, and the
 * form is one click away, on the same site or on another one. Opened there,
 * the scan found no fields, the fill declared the form done, and the review
 * screenshot was the job description. This counts the fillable controls; with
 * fewer than two and no file input it looks for the page's Apply control,
 * follows it when it stays on this site, and reports a link to another site
 * instead of following it: the browser is pinned to one site and would die on
 * the hop. Returns the page's own words for the control it used.
 */
export const reachApplicationFormCode = `
const fillable = () => page.evaluate(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const skip = new Set(["hidden", "submit", "button", "image", "checkbox", "radio", "search", "reset"]);
  const nodes = [...document.querySelectorAll("input, textarea, select, [role=combobox]")];
  let files = 0;
  let count = 0;
  for (const node of nodes) {
    const type = String(node.getAttribute("type") || node.tagName).toLowerCase();
    if (node.tagName === "INPUT" && type === "file") { files += 1; count += 1; continue; }
    if (skip.has(type) || !visible(node)) continue;
    count += 1;
  }
  return { count, files };
});
const enough = (found) => found.count >= 2 || found.files > 0;
const before = await fillable();
if (enough(before)) return { form: true, fields: before.count, clicked: "", href: page.url() };
const applyWording = /^\\s*(?:apply(?:\\s+now|\\s+here|\\s+for\\s+this\\s+(?:job|position|role)|\\s+to\\s+this\\s+(?:job|position|role))?|start\\s+(?:your\\s+)?application|i'?m\\s+interested)\\s*$/i;
const controls = await page.evaluate(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const applyWording = /^\\s*(?:apply(?:\\s+now|\\s+here|\\s+for\\s+this\\s+(?:job|position|role)|\\s+to\\s+this\\s+(?:job|position|role))?|start\\s+(?:your\\s+)?application|i'?m\\s+interested)\\s*$/i;
  const applyPath = /\\/(?:apply|application)(?:\\/|$|[?#])/i;
  return [...document.querySelectorAll("a, button, [role=button]")].flatMap((node, index) => {
    if (!visible(node)) return [];
    const text = (node.innerText || node.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
    const href = node.tagName === "A" ? String(node.href || "") : "";
    if (!applyWording.test(text) && !applyPath.test(href)) return [];
    return [{ href, index, text: text.slice(0, 60) }];
  }).slice(0, 5);
});
if (controls.length === 0) return { form: false, fields: before.count, clicked: "", href: page.url(), controls: 0 };
const chosen = controls.find((control) => control.href) || controls[0];
const site = (hostname) => hostname.toLowerCase().split(".").slice(-2).join(".");
if (chosen.href) {
  let target;
  try { target = new URL(chosen.href, page.url()); } catch { target = undefined; }
  if (target && /^https?:$/.test(target.protocol) && site(target.hostname) !== site(new URL(page.url()).hostname)) {
    return { form: false, fields: before.count, clicked: chosen.text, href: page.url(), external: target.href };
  }
  if (target) await page.goto(target.href, { timeout: 30000, waitUntil: "domcontentloaded" }).catch(() => undefined);
} else {
  await page.locator("a, button, [role=button]").nth(chosen.index).click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
}
await page.waitForTimeout(1500);
const after = await fillable();
return { form: enough(after), fields: after.count, clicked: chosen.text, href: page.url() };
`;

/**
 * What a page offers by way of moving on: its heading, any step indicator,
 * how many controls are still fillable, and every visible button and link,
 * numbered by its position in one fixed locator list so the click that
 * follows addresses the same element. Buttons come before links when the page
 * has more than fit: the control that advances a form is nearly always a
 * button, and a posting page can carry hundreds of links.
 */
export const pageControlsLocator =
  "button, [role=button], input[type=submit], a[href]";

export const collectPageControlsCode = `
const summary = await page.evaluate(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const text = (node) => (node.innerText || node.getAttribute("aria-label") || node.value || node.getAttribute("title") || "").replace(/\\s+/g, " ").trim();
  const headingNode = [...document.querySelectorAll("h1, h2, [role=heading]")].find(visible);
  const progress = [...document.querySelectorAll("[role=progressbar], [aria-current], nav li, ol li, [class*=step], [class*=progress]")]
    .filter(visible)
    .map(text)
    .filter((line) => line && line.length < 80 && /step|\\d+\\s*(?:of|\\/)\\s*\\d+|[0-9]\\s*[A-Za-z]/i.test(line))
    .slice(0, 8)
    .join(" | ")
    .slice(0, 240);
  const skip = new Set(["hidden", "submit", "button", "image", "checkbox", "radio", "search", "reset"]);
  const fields = [...document.querySelectorAll("input, textarea, select, [role=combobox]")].filter((node) => {
    const type = String(node.getAttribute("type") || node.tagName).toLowerCase();
    if (node.tagName === "INPUT" && type === "file") return true;
    return !skip.has(type) && visible(node);
  }).length;
  const all = [...document.querySelectorAll("${pageControlsLocator}")].flatMap((node, index) => {
    if (!visible(node)) return [];
    const label = text(node).slice(0, 60);
    if (!label) return [];
    return [{
      disabled: node.disabled === true || node.getAttribute("aria-disabled") === "true",
      href: node.tagName === "A" ? String(node.href || "") : "",
      index,
      link: node.tagName === "A",
      text: label,
    }];
  });
  const buttons = all.filter((control) => !control.link).slice(0, 40);
  const links = all.filter((control) => control.link).slice(0, Math.max(0, 60 - buttons.length));
  const controls = [...buttons, ...links].sort((left, right) => left.index - right.index)
    .map(({ link, ...control }) => control);
  return { controls, fields, heading: headingNode ? text(headingNode).slice(0, 120) : "", progress };
});
return { ...summary, href: page.url(), title: await page.title() };
`;

/**
 * Clicks one of the controls the summary numbered and reports where the page
 * went: its address, its new heading, and any validation text it put up. The
 * caller compares before and after; a page that did not move is its own
 * answer.
 */
export const clickControlCode = (index: number) => `
const control = page.locator("${pageControlsLocator}").nth(${String(index)});
const before = page.url();
try {
  await control.click({ timeout: 5000 });
} catch (error) {
  return { clicked: false, errors: [String(error && error.message || error).slice(0, 200)], heading: "", href: page.url(), navigated: false };
}
await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
await page.waitForTimeout(800);
const heading = await page.evaluate(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const node = [...document.querySelectorAll("h1, h2, [role=heading]")].find(visible);
  return node ? (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120) : "";
}).catch(() => "");
const errors = await page.$$eval(
  "[role=alert], [aria-invalid=true], .error, .field-error, [class*=error]",
  (nodes) => nodes
    .filter((node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.height > 0;
    })
    .map((node) => (node.innerText || node.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim())
    .filter((text) => text.length > 0 && text.length < 300)
    .slice(0, 5)
).catch(() => []);
return { clicked: true, errors, heading, href: page.url(), navigated: page.url() !== before };
`;

/**
 * Reads a page that wants an account before the form: whether it is a sign-in
 * or a registration page, which controls take the identifier, the password
 * (twice, on a registration page), and the consents, which numbered controls
 * create the account or switch to signing in, and the page's own wording of
 * its password rules. Indexes count the same locator the page-controls
 * summary does, so the click lands on the node the probe saw. No value is
 * read back, only selectors and control text.
 */
export const detectLoginWallCode = `
const probe = await page.evaluate((locator) => {
  ${domHelpers}
  const text = (node) => (node.innerText || node.getAttribute("aria-label") || node.value || node.getAttribute("title") || "").replace(/\\s+/g, " ").trim();
  const passwords = [...document.querySelectorAll("input[type=password]")].filter(visible);
  const inputs = [...document.querySelectorAll("input, textarea, select")];
  const controls = [...document.querySelectorAll(locator)].flatMap((node, index) => {
    if (!visible(node)) return [];
    const label = text(node).slice(0, 60);
    return label ? [{ index, link: node.tagName === "A", text: label }] : [];
  });
  const createWording = /create (?:an? |my |your )?account|sign ?up|register|get started|join now|new user/i;
  const signInWording = /^(?:sign ?in|log ?in|login|next|continue)$/i;
  const buttons = controls.filter((control) => !control.link);
  const createButton = buttons.find((control) => createWording.test(control.text));
  const signInButton = buttons.find((control) => /^(?:sign ?in|log ?in|login)$/i.test(control.text));
  const asControl = (control) => (control ? { index: control.index, text: control.text } : null);
  const createControl = asControl(createButton || controls.find((control) => createWording.test(control.text)));
  const signInControl = asControl(signInButton || controls.find((control) => /^(?:sign ?in|log ?in|login)$/i.test(control.text)));
  const headingNode = [...document.querySelectorAll("h1, h2, [role=heading]")].find(visible);
  const heading = headingNode ? text(headingNode) : "";
  const wall = passwords.length === 0
    ? "none"
    : passwords.length >= 2 || (createButton && !signInButton) || (createWording.test(heading) && !signInButton)
      ? "register"
      : "sign_in";
  const identifierWording = /e-?mail|user ?name|login|account/i;
  const identifierNode = inputs.find((node) => {
    if (!visible(node) || node.tagName !== "INPUT") return false;
    const type = String(node.getAttribute("type") || "text").toLowerCase();
    if (type === "email") return true;
    if (!["text", "tel"].includes(type)) return false;
    const hint = [node.name, node.id, node.getAttribute("autocomplete"), node.getAttribute("placeholder"), ownLabel(node)].join(" ");
    return identifierWording.test(hint);
  });
  const identifierKind = (node) => {
    const type = String(node.getAttribute("type") || "text").toLowerCase();
    const hint = [node.name, node.id, node.getAttribute("autocomplete"), node.getAttribute("placeholder"), ownLabel(node)].join(" ");
    if (type === "email" || /e-?mail/i.test(hint)) return "email";
    if (type === "tel" || /phone|mobile/i.test(hint)) return "phone";
    return "username";
  };
  const consents = inputs.flatMap((node, index) => {
    if (node.tagName !== "INPUT" || String(node.getAttribute("type") || "").toLowerCase() !== "checkbox" || !visible(node)) return [];
    const label = ownLabel(node) || text(node.closest("label") || node.parentElement || node);
    return /agree|terms|privacy|consent|acknowledge|accept|policy/i.test(label) ? [selectorFor(node, index)] : [];
  });
  const policyText = (document.body.innerText || "")
    .split(/\\n+/)
    .map((line) => line.replace(/\\s+/g, " ").trim())
    .filter((line) => line.length > 8 && line.length < 200 && /password|characters?\\b|uppercase|lowercase|special character|symbol|digit|number/i.test(line) && /\\d|uppercase|lowercase|symbol|special/i.test(line))
    .slice(0, 6)
    .join(" ")
    .slice(0, 500);
  return {
    consents,
    createControl,
    identifier: identifierNode
      ? { kind: identifierKind(identifierNode), selector: selectorFor(identifierNode, inputs.indexOf(identifierNode)) }
      : null,
    loginWall: wall !== "none",
    passwords: passwords.map((node) => selectorFor(node, inputs.indexOf(node))),
    policyText,
    signInControl,
    wall,
  };
}, "${pageControlsLocator}");
return { ...probe, href: page.url() };
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
