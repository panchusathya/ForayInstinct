/** Playwright/TypeScript run against the hosted `page` global. */

/**
 * Shared browser-side helpers. Inlined into each script because every script is
 * evaluated on its own — there is no module scope to hold them.
 */
import { twoPartTldList } from "@/lib/browser/domains";
import {
  submissionConfirmationText,
  submissionUrlPattern,
} from "@/lib/browser-submission";

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
  /**
   * A control with no id and no name gets a mark of our own, stamped on the
   * node so it survives every later scan. The positional fallback it replaces
   * shifted whenever the page gained a control (a repeater's Add moved every
   * later selector by a few places, and the runner read the shifted ones as
   * new) and was not valid CSS to begin with, so a fill aimed at it threw.
   */
  const selectorFor = (node, _index) => {
    if (node.id) return "#" + CSS.escape(node.id);
    const name = node.getAttribute("name");
    if (name) return node.tagName.toLowerCase() + "[name=" + JSON.stringify(name) + "]";
    let stamp = node.getAttribute("data-foray-id");
    if (!stamp) {
      stamp = "f" + Math.random().toString(36).slice(2, 10);
      node.setAttribute("data-foray-id", stamp);
    }
    return '[data-foray-id="' + stamp + '"]';
  };
  /** The repeating section a control sits in, when one has been marked. */
  const sectionOf = (node) => {
    const holder = node.closest("[data-foray-section]");
    return holder ? holder.getAttribute("data-foray-section") || "" : "";
  };
  const textOf = (element) => element
    ? String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim()
    : "";
  /**
   * Lookups run in the control's own root. A web component (ADP, UKG) keeps
   * its labels inside its shadow root, where document.getElementById cannot
   * see them; Playwright hands such a control over, so its root has to be
   * asked, with the document as the fallback.
   */
  const rootOf = (node) => node.getRootNode();
  const byId = (node, id) => {
    const root = rootOf(node);
    return (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
  };
  // The required mark as pages draw it: * , ✱ (Lever), ∗ and the full-width
  // star. A regex on "*" alone read every Lever question as optional.
  const STAR = /[*\\u2731\\u2217\\uFF0A]/;
  const REQUIRED_WORD = /\\(\\s*required\\s*\\)/i;
  const OPTIONAL_WORD = /\\(\\s*optional\\s*\\)/i;
  const PLACEHOLDER_WORDS = /^(?:select|choose|search|please select|start typing|type here)\\b[\\s.…]*(?:an? |one )?(?:option)?[\\s.…]*$/i;
  /**
   * A cookie or consent banner's switches are not the form. OneTrust draws
   * its preference toggles as role=switch inputs over the page, and they were
   * scanned as fields of the application.
   */
  const inConsentBanner = (node) => {
    const overlay = node.closest("[role=dialog], [aria-modal=true], [id^=onetrust], [class*=cookie], [id*=cookie]");
    return overlay !== null && /cookie|consent preferences|privacy preferences/i.test(textOf(overlay).slice(0, 400));
  };
  const controlSelector = "input, textarea, select, button, [role=combobox], [role=listbox], [role=radio], [role=checkbox], [role=switch], [contenteditable=true]";
  const isNativeChoice = (node) => node.tagName === "INPUT"
    && /^(radio|checkbox)$/i.test(String(node.getAttribute("type") || ""));
  /**
   * The controls in a container that belong to some other field. A container
   * with none is one field's own entry, and its text is that field's caption;
   * a container with any spans neighbours, whose words must not travel.
   * Hidden inputs and icon-only buttons (a typeahead's toggle) are nobody's.
   */
  const foreignControls = (container, own) => [...container.querySelectorAll(controlSelector)].filter((element) => {
    if (own.some((member) => member === element || member.contains(element) || element.contains(member))) return false;
    const type = String(element.getAttribute("type") || "").toLowerCase();
    if (type === "hidden") return false;
    if (!isFileInput(element) && !visible(element)) return false;
    if (element.tagName === "BUTTON" && textOf(element) === "" && !element.hasAttribute("aria-pressed")) return false;
    return true;
  });
  // aria-labelledby names the label by id, so it is as precise as label[for]
  // and is how a React-rendered control usually carries its question. Without
  // it such a field reads as unlabelled and there is nothing to ask about.
  const labelledByElements = (node) => String(node.getAttribute("aria-labelledby") || "")
    .split(/\\s+/)
    .filter(Boolean)
    .map((id) => byId(node, id))
    .filter(Boolean);
  const labelledByText = (node) => labelledByElements(node).map(textOf).filter(Boolean).join(" ");
  const labelForId = (node) => node.id
    ? rootOf(node).querySelector("label[for=" + JSON.stringify(node.id) + "]")
    : null;
  /**
   * A label bound to the control's name rather than its id. Ashby binds every
   * label to the field key, which is the name of the control it belongs to and
   * the id of nothing; read by id, its Yes/No questions had no wording at all.
   */
  const labelForName = (node) => {
    const name = node.getAttribute("name");
    if (!name || byId(node, name)) return null;
    return rootOf(node).querySelector("label[for=" + JSON.stringify(name) + "]");
  };
  /**
   * A caption inside a container that names the field rather than one of its
   * options: a legend, or a label bound to nothing. A label bound to an
   * element is that element's, whether an option's or a neighbour's.
   */
  const captionElementIn = (container, own) => [...container.querySelectorAll("legend, label")].find((element) => {
    if (own.some((member) => element === member || element.contains(member) || member.contains(element))) return false;
    const forId = element.getAttribute("for");
    if (forId && byId(element, forId)) return false;
    return textOf(element) !== "";
  });
  /**
   * The field entry around a control or a choice group: the nearest ancestor
   * holding it and no other field. Its caption is a label or legend bound to
   * nothing, else its own text with the control's words taken out. The page's
   * "* indicates a required field" note sits beside many controls, so the
   * ancestor holding it never qualifies and its words never reach a field;
   * that is the guarantee the own-label rule gave, kept.
   */
  const fieldCaption = (own, ownTexts) => {
    let ancestor = own[0].parentElement;
    for (let depth = 0; ancestor && depth < 6; depth += 1, ancestor = ancestor.parentElement) {
      if (ancestor === document.body || ancestor.tagName === "FORM") break;
      if (!own.every((member) => ancestor.contains(member))) continue;
      if (foreignControls(ancestor, own).length > 0) break;
      const element = captionElementIn(ancestor, own);
      if (element) return { container: ancestor, element, text: textOf(element) };
      let text = textOf(ancestor);
      // The control's own words come out first: a select's text is every
      // option it offers, thousands of characters on Lever's school list.
      for (const word of ownTexts.concat(own.map(textOf))) if (word) text = text.split(word).join(" ");
      text = text.replace(/\\s+/g, " ").trim();
      // A widget's painted placeholder ("Select...", "Search") is not its
      // caption; the caption sits one level further out.
      if (PLACEHOLDER_WORDS.test(text)) text = "";
      if (text !== "" && text.length <= 300) return { container: ancestor, element: null, text };
    }
    return { container: null, element: null, text: "" };
  };
  /**
   * What the page calls a control, and where it says so. In order: the
   * elements aria-labelledby names, the label bound to its id, the label
   * wrapping it, the label bound to its name, then its own field entry.
   */
  const captionFor = (node) => {
    const named = labelledByElements(node);
    if (named.length > 0 && labelledByText(node)) {
      return { container: named[0].parentElement, element: named[0], text: labelledByText(node) };
    }
    const byFor = labelForId(node);
    if (byFor && textOf(byFor)) return { container: byFor.parentElement, element: byFor, text: textOf(byFor) };
    const wrapping = node.closest("label");
    if (wrapping && textOf(wrapping)) return { container: wrapping.parentElement, element: wrapping, text: textOf(wrapping) };
    const byName = labelForName(node);
    if (byName && textOf(byName)) return { container: byName.parentElement, element: byName, text: textOf(byName) };
    return fieldCaption([node], [node.getAttribute("placeholder") || "", String(node.value || "")]);
  };
  const ownLabel = (node) => captionFor(node).text;
  // An aria-label or placeholder that only says "Select" or "Search" names
  // the widget, not the question; a control with no better word is unlabelled.
  const labelFor = (node) => ownLabel(node)
    || [node.getAttribute("aria-label"), node.getAttribute("placeholder"), node.getAttribute("name")]
      .map((text) => String(text || "").trim())
      .find((text) => text !== "" && !PLACEHOLDER_WORDS.test(text))
    || "";
  /**
   * Whether an element carries the required mark: a star in its text, the
   * word in its class (Ashby's label, Lever's field), a star drawn by CSS
   * after it (Ashby, ADP), or a marked descendant.
   */
  const starMarked = (element) => {
    if (!element || element === document.body) return false;
    const text = textOf(element);
    if (STAR.test(text) || REQUIRED_WORD.test(text)) return true;
    if (/(^|[\\s_-])required([\\s_-]|$)/i.test(String(element.className || ""))) return true;
    if (element.querySelector('[class*="required"], abbr[title*="required" i]') !== null) return true;
    try {
      if (STAR.test(getComputedStyle(element, "::after").content)) return true;
    } catch (error) {
      // A detached node has no computed style; it is not marked.
    }
    return false;
  };
  /**
   * The mark is read from the control's own caption and its own field entry,
   * never from beyond: an ancestor spanning other fields is where the page's
   * "* indicates a required field" note lives.
   */
  const captionRequired = (caption, own) => {
    if (OPTIONAL_WORD.test(caption.text)) return false;
    if (STAR.test(caption.text) || REQUIRED_WORD.test(caption.text) || starMarked(caption.element)) return true;
    const entry = caption.container;
    return entry !== null && entry !== document.body
      && foreignControls(entry, own).length === 0
      && starMarked(entry);
  };
  const isRequired = (node) => node.required === true
    || node.getAttribute("aria-required") === "true"
    || captionRequired(captionFor(node), [node]);
  /**
   * Whether this node is the editable interior of a select-like widget rather
   * than the widget itself: some other element carries the combobox role for
   * it and is drawn. Nothing broader. A react-select puts role=combobox on its
   * typeahead input, so that input IS the widget; a rule that skipped every
   * input with aria-autocomplete removed every dropdown on a Greenhouse form
   * from both scans at once, so nothing filled them and nothing reported them
   * blank, and the form went to the candidate for approval with all of them
   * empty. An owner the page does not draw (Rippling keeps a hidden
   * role=combobox shell beside the visible input) owns nothing.
   */
  const isWidgetInterior = (node) => {
    const owner = node.closest("[role=combobox], [role=listbox]");
    return Boolean(owner && owner !== node && visible(owner));
  };
  /**
   * A control that opens a list, whatever it calls itself: the ARIA roles, an
   * input that says it autocompletes from a list (Rippling's location has the
   * behaviour and no role), or a button that pops a listbox (Workday).
   */
  const isListControl = (node) => {
    const role = String(node.getAttribute("role") || "").toLowerCase();
    if (role === "combobox" || role === "listbox") return true;
    const haspopup = String(node.getAttribute("aria-haspopup") || "").toLowerCase();
    const tag = node.tagName.toLowerCase();
    if (tag === "input" && (String(node.getAttribute("aria-autocomplete") || "").toLowerCase() === "list" || haspopup === "listbox")) return true;
    return tag === "button" && haspopup === "listbox";
  };
  /** The element a person clicks for an option: its proxy, its label, or itself. */
  const proxyFor = (option) => {
    if (!isNativeChoice(option)) return option;
    return option.closest("[role=radio], [role=checkbox], [role=switch]") || labelForId(option) || option.closest("label") || option;
  };
  const optionText = (option) => {
    if (isNativeChoice(option)) {
      return textOf(labelForId(option)) || textOf(option.closest("label")) || labelledByText(option)
        || textOf(option.closest("[role=radio], [role=checkbox]"))
        || String(option.getAttribute("aria-label") || option.value || "").trim();
    }
    return textOf(option) || labelledByText(option)
      || String(option.getAttribute("aria-label") || option.getAttribute("data-value") || "").trim();
  };
  const optionChecked = (option) => isNativeChoice(option)
    ? option.checked === true
    : option.getAttribute("aria-checked") === "true" || option.getAttribute("aria-pressed") === "true";
  const optionSelector = "input[type=radio], input[type=checkbox], [role=radio], [role=checkbox], [role=switch], button[aria-pressed]";
  const commonAncestor = (elements) => {
    let ancestor = elements[0];
    while (ancestor && !elements.every((element) => ancestor.contains(element))) ancestor = ancestor.parentElement;
    return ancestor || elements[0];
  };
  /**
   * The caption of a choice group: what the group wrapper is labelled by, its
   * legend, a label inside it bound to nothing (Ashby's question label sits in
   * the fieldset with the options), else the field entry around it. Never an
   * option's own label, which is what a group without a legend used to be
   * called: "Yes".
   */
  const groupCaption = (container, members, optionTexts) => {
    const named = labelledByElements(container);
    if (named.length > 0 && labelledByText(container)) {
      return { container: container.parentElement, element: named[0], text: labelledByText(container) };
    }
    const legend = container.querySelector("legend");
    if (legend && textOf(legend)) return { container, element: legend, text: textOf(legend) };
    const own = members.concat(members.map((member) => proxyFor(member)));
    const inside = container !== members[0] ? captionElementIn(container, own) : undefined;
    if (inside) return { container, element: inside, text: textOf(inside) };
    return fieldCaption(container === members[0] ? members : [container], optionTexts);
  };
  /**
   * The choice group a node belongs to, or undefined for a node that is not a
   * choice control. One model for every way a page draws a single choice:
   * native radios sharing a name (drawn, at opacity 0 under a styled span, or
   * hidden behind a role=radio proxy), role=radio elements in a radiogroup or
   * a fieldset, and Yes/No drawn as two aria-pressed buttons over a hidden
   * checkbox (Ashby). Checkboxes sharing a name or a fieldset are one
   * multiple-choice group; a lone checkbox is its own.
   */
  const choiceGroupOf = (node) => {
    const tag = node.tagName.toLowerCase();
    const role = String(node.getAttribute("role") || "").toLowerCase();
    const type = String(node.getAttribute("type") || "").toLowerCase();
    const native = tag === "input" && (type === "radio" || type === "checkbox");
    const proxy = role === "radio" || role === "checkbox" || role === "switch"
      || (tag === "button" && node.hasAttribute("aria-pressed"));
    if (!native && !proxy) return undefined;
    const name = native ? String(node.getAttribute("name") || "") : "";
    let container = null;
    let members = [];
    if (native && name) {
      members = [...rootOf(node).querySelectorAll("input[type=" + type + "][name=" + JSON.stringify(name) + "]")];
      container = members.length > 1 ? commonAncestor(members) : null;
      if (members.length === 1) {
        // A lone named checkbox may still be one of a fieldset's options, as
        // Ashby names each option by its own text.
        const group = node.closest("fieldset, [role=group], [role=radiogroup]");
        const siblings = group ? [...group.querySelectorAll("input[type=" + type + "]")] : [];
        if (group && siblings.length > 1 && foreignControls(group, siblings).length === 0) {
          container = group;
          members = siblings;
        }
      }
    } else if (!native) {
      // Proxies name nothing: the group is the nearest ancestor holding two or
      // more of them and no other field.
      let ancestor = node.parentElement;
      for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
        const found = [...ancestor.querySelectorAll(optionSelector)];
        // The drawn options are the group; a native control among them is
        // the record behind them (Ashby's hidden checkbox under its Yes/No
        // buttons, the radio inside a role=radio element), not an option.
        const drawn = found.filter((option) => !isNativeChoice(option));
        const candidates = drawn.length >= 2 ? drawn : found;
        if (candidates.length < 2) continue;
        if (foreignControls(ancestor, candidates).length > 0) break;
        container = ancestor;
        members = candidates;
        break;
      }
    }
    if (!container) {
      container = node;
      members = [node];
    }
    // Drawn somewhere: a group whose every option and proxy is hidden is not
    // one a candidate can touch (react-select's decoy required input is one).
    const shown = members.some((member) => visible(proxyFor(member)) || (visible(member) && !assistiveHidden(member)));
    if (!shown) return undefined;
    const kind = native ? type : (role === "radio" || tag === "button" ? "radio" : "checkbox");
    const options = members.map((member) => ({ element: member, proxy: proxyFor(member), text: optionText(member) }));
    const caption = members.length > 1 || container !== node
      ? groupCaption(container, members, options.map((option) => option.text))
      : captionFor(node);
    const required = members.some((member) => member.required === true || member.getAttribute("aria-required") === "true")
      || container.getAttribute("aria-required") === "true"
      || captionRequired(caption, members.concat(members.map((member) => member.closest("label") || member)));
    const selector = native && name && members.length > 1 && container !== node
      ? "input[type=" + type + "][name=" + JSON.stringify(name) + "]"
      : selectorFor(container, 0);
    return { caption, container, kind, members, name, options, required, selector };
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
/**
 * Every control the scans look at. Beyond native controls and the ARIA list
 * roles: the elements a page draws a choice with (role=radio, role=checkbox,
 * role=switch, a Yes/No pair of aria-pressed buttons), an input that
 * autocompletes from a list without saying it is a combobox, and a button
 * that pops a listbox.
 */
const scanSelector =
  "input, textarea, select, [role=combobox], [role=radiogroup], [role=listbox], [role=radio], [role=checkbox], [role=switch], button[aria-pressed], button[aria-haspopup=listbox], input[aria-autocomplete=list], input[aria-haspopup=listbox]";

export const collectVisibleFieldsCode = `
const fields = await page.$$eval(
  ${JSON.stringify(scanSelector)},
  (nodes) => {
${domHelpers}
    const optionsFor = (node) => {
      const tag = node.tagName.toLowerCase();
      if (tag === "select") {
        return [...node.options].map((option) => (option.label || option.text || "").trim()).filter(Boolean);
      }
      const owned = node.getAttribute("aria-controls") || node.getAttribute("aria-owns");
      const listbox = (owned && byId(node, owned))
        || node.parentElement?.querySelector("[role=listbox]");
      if (listbox) {
        return [...listbox.querySelectorAll("[role=option]")]
          .map((option) => (option.innerText || "").trim())
          .filter(Boolean);
      }
      return [];
    };
    const seenGroups = new Set();
    return nodes.flatMap((node, index) => {
      if (inConsentBanner(node)) return [];
      // One entry per choice group, not per option, whatever the options are
      // drawn as; and read before the visibility test, because the native
      // control behind a styled option is often hidden while its proxy shows.
      const group = choiceGroupOf(node);
      if (group) {
        if (seenGroups.has(group.container)) return [];
        seenGroups.add(group.container);
        const grouped = group.members.length > 1;
        return [{
          label: group.caption.text.slice(0, 200),
          ...(grouped && group.kind === "checkbox" ? { multiple: true } : {}),
          name: group.name,
          options: grouped ? group.options.map((option) => option.text).filter(Boolean) : [],
          required: group.required,
          section: sectionOf(group.container),
          selector: group.selector,
          tag: group.kind,
          type: group.kind,
        }];
      }
      if (!candidateFacing(node)) return [];
      const tagName = node.tagName.toLowerCase();
      const role = (node.getAttribute("role") || "").toLowerCase();
      const type = (node.getAttribute("type") || tagName).toLowerCase();
      // A radiogroup wrapper's options were collected through the options.
      if (role === "radiogroup") return [];
      if (type === "hidden" || type === "submit" || type === "image") return [];
      if (type === "button" && !isListControl(node)) return [];
      // A widget's inner input is part of the combobox already collected, not
      // a field of its own. Counted separately it becomes a required control
      // with no label and nothing to ask about.
      if (isWidgetInterior(node)) return [];

      const kind = isListControl(node)
        ? "combobox"
        : type === "file"
          ? "file"
          : tagName;
      return [{
        label: labelFor(node).slice(0, 200),
        name: node.getAttribute("name") || "",
        options: optionsFor(node),
        required: isRequired(node),
        section: sectionOf(node),
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
  // A prefix settles it only when it settles it: "MA" begins Maine, Maryland
  // and Massachusetts alike, and the first of those was taken.
  for (const value of values) {
    const wanted = value.toLowerCase();
    const partial = options.filter((option) => {
      const text = option.trim().toLowerCase();
      return text.startsWith(wanted) || wanted.startsWith(text);
    });
    if (partial.length === 1) return partial[0];
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
    const shape = await locator.evaluate((node) => {
      const isChoice = (element) => element.tagName === "INPUT"
        && /^(radio|checkbox)$/i.test(String(element.getAttribute("type") || ""));
      // The options a group selector resolves to: the named radios or
      // checkboxes themselves, or the drawn options inside a container (a
      // role=radio element, a Yes/No button, a native control under a label).
      // Drawn proxies win over the native controls they stand for.
      if (isChoice(node)) {
        const name = node.getAttribute("name");
        const type = String(node.getAttribute("type")).toLowerCase();
        const peers = name
          ? [...node.getRootNode().querySelectorAll("input[type=" + type + "][name=" + JSON.stringify(name) + "]")]
          : [node];
        return { kind: type, options: peers.length };
      }
      const proxies = [...node.querySelectorAll("[role=radio], [role=checkbox], [role=switch], button[aria-pressed]")];
      const natives = [...node.querySelectorAll("input[type=radio], input[type=checkbox]")];
      const options = proxies.length > 0 ? proxies : natives;
      const roleHere = String(node.getAttribute("role") || "").toLowerCase();
      if (options.length === 0) {
        return roleHere === "checkbox" || roleHere === "switch" ? { kind: "checkbox", options: 0 } : undefined;
      }
      const single = options.every((option) => (option.getAttribute("role") || "").toLowerCase() === "checkbox"
        || (option.getAttribute("role") || "").toLowerCase() === "switch"
        || String(option.getAttribute("type") || "").toLowerCase() === "checkbox");
      return { kind: single ? "checkbox" : "radio", options: options.length };
    });

    if (shape && shape.options > 0 && !(shape.kind === "checkbox" && shape.options === 1)) {
      // One choice group, however the page draws it. Each option is named by
      // its label, its proxy's text or its value, and chosen by clicking what
      // a person would click: the drawn proxy, the label, then the control
      // itself, forced as a last resort. Nothing counts as chosen until the
      // page says so; a check() that Playwright refused on a hidden control
      // used to land in skipped under an error nobody re-asked about.
      const optionLocator = type === "radio" || type === "checkbox"
        ? page.locator(fill.selector)
        : locator.locator("[role=radio], [role=checkbox], [role=switch], button[aria-pressed]").or(locator.locator("input[type=radio], input[type=checkbox]"));
      const count = await optionLocator.count();
      const texts = [];
      for (let i = 0; i < count; i += 1) {
        texts.push(String(await optionLocator.nth(i).evaluate((node) => {
          const root = node.getRootNode();
          const text = (element) => element ? String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim() : "";
          const named = String(node.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean)
            .map((id) => (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id)).map(text).filter(Boolean).join(" ");
          if (node.tagName === "INPUT") {
            const byFor = node.id ? root.querySelector("label[for=" + JSON.stringify(node.id) + "]") : null;
            return text(byFor) || text(node.closest("label")) || named || text(node.closest("[role=radio], [role=checkbox]")) || String(node.getAttribute("aria-label") || node.value || "").trim();
          }
          return text(node) || named || String(node.getAttribute("aria-label") || node.getAttribute("data-value") || "").trim();
        })));
      }
      const isOn = (option) => option.evaluate((node) => node.tagName === "INPUT"
        ? node.checked === true
        : node.getAttribute("aria-checked") === "true" || node.getAttribute("aria-pressed") === "true");
      const choose = async (option) => {
        if (await isOn(option)) return true;
        const attempts = [
          () => option.evaluate((node) => {
            const root = node.getRootNode();
            const proxy = node.tagName === "INPUT"
              ? node.closest("[role=radio], [role=checkbox], [role=switch]")
                || (node.id ? root.querySelector("label[for=" + JSON.stringify(node.id) + "]") : null)
                || node.closest("label")
              : node;
            (proxy || node).click();
          }),
          () => option.click({ timeout: 3000 }),
          () => option.click({ force: true, timeout: 3000 }),
        ];
        for (const attempt of attempts) {
          await attempt().catch(() => undefined);
          await page.waitForTimeout(150);
          if (await isOn(option)) return true;
        }
        return false;
      };
      // A multiple-choice group takes every listed answer; a single choice the
      // first phrasing that matches.
      const wanted = shape.kind === "checkbox" && count > 1
        ? String(fill.value).split(/\\s*[;|]\\s*|,\\s+/).map((part) => part.trim()).filter(Boolean)
        : [undefined];
      let chosen = 0;
      for (const part of wanted) {
        const match = matchOption(texts, part === undefined ? wantedList(fill) : [part]);
        if (match === undefined) continue;
        const option = optionLocator.nth(texts.indexOf(match));
        if (await choose(option)) chosen += 1;
        if (part === undefined) break;
      }
      if (chosen > 0) {
        filled.push(fill.selector);
      } else {
        offered.push({ options: texts, selector: fill.selector });
        skipped.push({ reason: "no-option", selector: fill.selector });
      }
      continue;
    }

    if (type === "checkbox" || (shape && shape.kind === "checkbox")) {
      const on = /^(yes|true|1|on|checked)$/i.test(String(fill.value).trim());
      if (type === "checkbox") {
        if (on) await locator.check();
        else await locator.uncheck();
      } else {
        // A role=checkbox or role=switch element: click when its state differs.
        const state = await locator.getAttribute("aria-checked");
        if ((state === "true") !== on) await locator.click({ timeout: 3000 });
      }
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

    const autocompletes = String(await locator.getAttribute("aria-autocomplete") || "").toLowerCase() === "list";
    const popsList = String(await locator.getAttribute("aria-haspopup") || "").toLowerCase() === "listbox";
    if (role === "combobox" || role === "listbox" || autocompletes || popsList) {
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
      // The widget's own list when it names one, so two open lists on a page
      // cannot swap options; the whole page when it does not (a react-select
      // portal without aria-controls still resolves this way).
      const owned = (await locator.getAttribute("aria-controls").catch(() => null))
        || (await locator.getAttribute("aria-owns").catch(() => null));
      const ownedBox = owned ? page.locator("[id=" + JSON.stringify(owned) + "]") : undefined;
      const ownedCount = ownedBox ? await ownedBox.locator("[role=option]").count().catch(() => 0) : 0;
      const optionRoot = ownedBox && ownedCount > 0 ? ownedBox : page;
      const liveOptions = () => optionRoot.locator("[role=option]").evaluateAll((nodes) => nodes
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
      // A readonly combobox input (Workable) is a closed list opened by the
      // click above; typing into it does nothing.
      const readonly = (await box.count()) > 0 && (await box.getAttribute("readonly").catch(() => null)) !== null;
      const typeahead = shown.length === 0 && (await box.count()) > 0 && !readonly;
      if (wanted === undefined && typeahead) {
        for (const value of wantedList(fill)) {
          await box.fill(value);
          // A geocoding suggestion is a network round trip through the proxy;
          // 2.5s cut Ashby's off and the city never landed.
          const deadline = Date.now() + 4000;
          live = [];
          while (live.length === 0 && Date.now() < deadline) {
            await page.waitForTimeout(200);
            live = await liveOptions();
          }
          wanted = matchOption(live, [value]);
          // The suggestion the widget itself put first is the page's own
          // reading of what was typed ("San Francisco" → "San Francisco,
          // California, United States"); take it when it begins that way.
          if (wanted === undefined && live.length > 0) {
            const first = await optionRoot.locator("[role=option][aria-selected=true]").first().innerText().catch(() => "");
            const typed = value.trim().toLowerCase();
            if (first && first.trim().toLowerCase().startsWith(typed)) wanted = first.trim();
          }
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
      // Bounded: an option that never became clickable used to hold the whole
      // batch past its budget, and a batch that never reported back read as
      // one that filled everything.
      await optionRoot.getByRole("option", { name: wanted, exact: true }).first().click({ timeout: 5000 });
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
/**
 * Which of the number's shapes a control holds right now, as an index into
 * the list given, or -1. The retry after a refused submit used to assume the
 * first shape had been tried, which held only when the runner itself had
 * typed it. Nothing but the index comes back.
 */
export const phoneRenderingIndexCode = (
  selector: string,
  renderings: string[]
) => `
const renderings = ${JSON.stringify(renderings)};
const value = String(await page.locator(${JSON.stringify(selector)}).first().inputValue().catch(() => "")).trim();
const digits = (text) => String(text || "").replace(/\\D/g, "");
const exact = renderings.findIndex((rendering) => rendering === value);
const same = digits(value) === "" ? -1 : renderings.findIndex((rendering) => digits(rendering) === digits(value));
return { index: exact >= 0 ? exact : same };
`;

export const collectEmptyRequiredFieldsCode = `
const empty = await page.$$eval(
  ${JSON.stringify(scanSelector)},
  (nodes) => {
${domHelpers}
    const seenGroups = new Set();
    return nodes.flatMap((node, index) => {
      if (inConsentBanner(node)) return [];
      // A choice group is blank when none of its options is on, whatever the
      // options are drawn as. The same model the field scan uses, so a group
      // the scan can see is one this check can report; a radiogroup of
      // role=radio elements used to be visible to neither.
      const group = choiceGroupOf(node);
      if (group) {
        if (seenGroups.has(group.container)) return [];
        seenGroups.add(group.container);
        if (!group.required) return [];
        if (group.members.some((member) => optionChecked(member))) return [];
        return [{
          label: group.caption.text.slice(0, 200),
          nearby: "",
          options: group.members.length > 1 ? group.options.map((option) => option.text).filter(Boolean) : [],
          selector: group.selector,
          tag: group.kind,
        }];
      }
      if (!candidateFacing(node)) return [];
      const tagName = node.tagName.toLowerCase();
      const role = (node.getAttribute("role") || "").toLowerCase();
      const type = (node.getAttribute("type") || tagName).toLowerCase();
      if (role === "radiogroup") return [];
      if (type === "hidden" || type === "submit" || type === "image") return [];
      if (type === "button" && !isListControl(node)) return [];
      // A widget's inner input is part of the combobox already collected, not
      // a field of its own. Counted separately it becomes a required control
      // with no label and nothing to ask about.
      if (isWidgetInterior(node)) return [];
      if (!isRequired(node)) return [];
      let blank;
      if (type === "file") {
        blank = !(node.files && node.files.length > 0);
      } else if (isListControl(node)) {
        // Whatever the widget shows once a choice is made. A react-select keeps
        // its typeahead input empty and paints the chosen option in a sibling,
        // so the input alone reads blank forever and the run stalls on a
        // question the candidate has already answered. Read the widget's own
        // field entry and treat any text other than the label, a placeholder
        // or the required mark as a choice. Only its own entry: the walk used
        // to run three levels up regardless, and on Ashby read the neighbour's
        // answer as this field's.
        const own = (node.value || node.innerText || node.textContent || "").trim();
        const label = labelFor(node).replace(/\\s+/g, " ").trim();
        const placeholderNode = describedPlaceholder(node);
        const placeholders = [
          node.getAttribute("placeholder") || "",
          placeholderNode ? (placeholderNode.innerText || placeholderNode.textContent || "") : "",
        ].map((text) => text.replace(/\\s+/g, " ").trim()).filter(Boolean);
        let shown = "";
        let ancestor = node.parentElement;
        for (let depth = 0; ancestor && depth < 4 && shown === ""; depth += 1, ancestor = ancestor.parentElement) {
          if (ancestor === document.body || foreignControls(ancestor, [node]).length > 0) break;
          shown = textOf(ancestor);
          if (label) shown = shown.split(label).join(" ");
          for (const placeholder of placeholders) shown = shown.split(placeholder).join(" ");
          shown = shown.replace(STAR, " ").replace(REQUIRED_WORD, " ").replace(/\\s+/g, " ").trim();
        }
        const chosen = shown !== ""
          && !placeholders.includes(shown)
          && !/^(select|choose|please select|start typing)\\b[\\s.…]*(an? |one )?(option)?\\.{0,3}$/i.test(shown);
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
      // The group's own caption only. A div ancestor spanned neighbouring
      // fields, and the text read off it carried the choices already made in
      // them (a veteran status, an ethnicity) into the log.
      const wrapper = label === "" ? node.closest("fieldset, [role=group]") : undefined;
      const caption = wrapper ? wrapper.querySelector("legend, [role=heading], h1, h2, h3, h4, label") : undefined;
      const nearby = caption ? (caption.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120) : "";
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
  const wrapper = node.closest("fieldset, [role=group]");
  const caption = wrapper && wrapper.querySelector("legend, [role=heading], label");
  const tidy = (parts) => parts.filter(Boolean).join(" ").replace(/\\s+/g, " ").slice(0, 400);
  return {
    own: tidy([node.id, node.getAttribute("name"), node.getAttribute("aria-label"),
      byFor && byFor.innerText, own && own.innerText]),
    nearby: tidy([caption && caption.innerText]),
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
  if (method === "payload" && payload) {
    // Built inside the try: a Buffer this executor does not have used to
    // throw here, before attach's own catch, and the DOM route below that
    // needed nothing but atob in the page was never reached.
    let files;
    try {
      files = { name: payload.name, mimeType: payload.mimeType, buffer: Buffer.from(payload.base64, "base64") };
    } catch (error) {
      attempts.push("payload: " + describeError(error));
    }
    if (files && await attach("payload", files)) via = "payload";
  }
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
  // A country code, a zip code and a dial code are codes too, and a form with
  // one of them beside an email-confirmation line paused a run as waiting on
  // a verification code before a single field was read.
  const notACode = /country|zip|postal|dial|area|phone|address|promo|discount|referral/;
  const codeLike = (node) => {
    const attrs = ["autocomplete", "name", "id", "placeholder", "aria-label", "inputmode"]
      .map((name) => node.getAttribute(name) || "").join(" ").toLowerCase();
    if (notACode.test(attrs)) return false;
    return /one-time-code|otp|verif|passcode|\\bcode\\b|numeric|\\bpin\\b|security|token|digit/.test(attrs) || inCluster(node);
  };
  // The nearest enclosure that could be the dialog asking, never the whole
  // page: body text mentions verification on many a form that asks for none.
  const contextOf = (node) => node.closest("[role=dialog], dialog, fieldset, form, section") || node.parentElement || node;
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
  const confirmed = new RegExp(${JSON.stringify(submissionConfirmationText.source)}, "i").test(text);
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
// A board that paints its form from the client (Ashby fetches the posting
// after domcontentloaded) has nothing to fill for a few seconds; the scan that
// sent the runner here saw that empty shell. Give the form that long before
// reading the page as a description.
const settle = async (budgetMs) => {
  const deadline = Date.now() + budgetMs;
  let found = await fillable();
  let previous = -1;
  // Enough, and steady: a form that paints in stages is read once two polls
  // in a row agree on its size, not at the first two controls.
  while (Date.now() < deadline && (!enough(found) || found.count !== previous)) {
    previous = found.count;
    await page.waitForTimeout(500);
    found = await fillable();
  }
  return found;
};
const before = await settle(8000);
if (enough(before)) return { form: true, fields: before.count, clicked: "", href: page.url() };
// Tabs and role=link controls count: Ashby's description page switches to the
// form through an "Application" tab, which is neither a button nor apply
// wording. The same selector drives the click below, so indexes agree.
const controlSelector = "a, button, [role=button], [role=tab], [role=link]";
const controls = await page.evaluate((selector) => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const applyWording = /^\\s*(?:apply(?:\\s+now|\\s+here|\\s+for\\s+this\\s+(?:job|position|role)|\\s+to\\s+this\\s+(?:job|position|role))?|start\\s+(?:your\\s+)?application|i'?m\\s+interested)\\s*$/i;
  const tabWording = /^\\s*(?:application|apply|apply\\s+manually|continue\\s+(?:to\\s+)?(?:the\\s+)?application)\\s*$/i;
  const applyPath = /\\/(?:apply|application)(?:\\/|$|[?#])/i;
  // "Apply with Indeed" hands the candidate to another site's sign-in, not to
  // the form. SmartRecruiters opens on a row of those above the manual path.
  const thirdParty = /\\bwith\\s+(?:indeed|linkedin|seek|google|facebook|apple)\\b/i;
  return [...document.querySelectorAll(selector)].flatMap((node, index) => {
    if (!visible(node)) return [];
    const text = (node.innerText || node.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
    if (thirdParty.test(text)) return [];
    const anchor = node.closest("a");
    const href = anchor ? String(anchor.href || "") : String(node.getAttribute("href") || "");
    // Apply wording first, then a link into the form, then a bare tab label.
    const rank = applyWording.test(text) ? 0 : applyPath.test(href) ? 1 : tabWording.test(text) ? 2 : -1;
    if (rank < 0) return [];
    return [{ href, index, rank, text: text.slice(0, 60) }];
  }).sort((a, b) => a.rank - b.rank).slice(0, 5);
}, controlSelector);
if (controls.length === 0) return { form: false, fields: before.count, clicked: "", href: page.url(), controls: 0 };
const chosen = controls.find((control) => control.href) || controls[0];
// The same registrable-domain rule the gateway pins a browser to, so a hop
// the browser would die on is always called external here first. Two labels
// alone read every .co.uk as one site.
const twoPartTlds = new Set(${JSON.stringify([...twoPartTldList])});
const site = (hostname) => {
  const labels = String(hostname || "").toLowerCase().replace(/\\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const keep = twoPartTlds.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-keep).join(".");
};
if (chosen.href) {
  let target;
  try { target = new URL(chosen.href, page.url()); } catch { target = undefined; }
  if (target && /^https?:$/.test(target.protocol) && site(target.hostname) !== site(new URL(page.url()).hostname)) {
    return { form: false, fields: before.count, clicked: chosen.text, href: page.url(), external: target.href };
  }
  const here = new URL(page.url());
  const trimSlash = (path) => path.replace(/\\/+$/, "");
  const samePage = target && target.origin === here.origin && trimSlash(target.pathname) === trimSlash(here.pathname);
  if (samePage) {
    // A link to the page already open is one of its own tabs. Reloading it
    // through the proxy is what outran the gateway's budget on Ashby; the tab
    // switches in place, so click it and let the form settle.
    await page.locator(controlSelector).nth(chosen.index).click({ timeout: 5000 }).catch(() => undefined);
  } else if (target) {
    // Shorter than the script's own budget on the gateway, so a slow hop is
    // reported by this script rather than by the gateway killing it.
    await page.goto(target.href, { timeout: 15000, waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
} else {
  await page.locator(controlSelector).nth(chosen.index).click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
}
const after = await settle(6000);
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
const pageControlsLocator =
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
 * The Add controls of a form's repeating sections (Work Experience,
 * Education), each with the heading and visible text of the section it
 * belongs to. Indexes count the page-controls locator, so the click lands on
 * the control this saw. The section text lets the caller tell an entry that
 * is already on the page from one still to add.
 */
export const collectRepeaterSectionsCode = `
const sections = await page.evaluate((locator) => {
  ${domHelpers}
  const text = (node) => (node.innerText || node.getAttribute("aria-label") || node.value || node.getAttribute("title") || "").replace(/\\s+/g, " ").trim();
  const addWording = /^(?:\\+\\s*)?add(?:\\s+another|\\s+a|\\s+new)?(?:\\s+(?:work\\s+)?experience|\\s+education|\\s+job|\\s+position|\\s+employment|\\s+school|\\s+entry|\\s+row|\\s+more|\\s+degree)?$/i;
  const isAdd = (node) => addWording.test(text(node)) || /^add\\b/i.test(node.getAttribute("aria-label") || "");
  const headingOf = (container) => {
    const node = [...container.querySelectorAll("h1, h2, h3, h4, legend, [role=heading]")].find(visible);
    return node ? text(node).slice(0, 120) : "";
  };
  return [...document.querySelectorAll(locator)].flatMap((node, index) => {
    if (!visible(node) || !isAdd(node)) return [];
    let container = node.parentElement;
    while (container && container !== document.body && headingOf(container) === "") container = container.parentElement;
    const scope = container && container !== document.body ? container : node.parentElement || document.body;
    // Marked so the next scan can say which controls belong to this section:
    // a block was read as "every selector not seen before", and controls
    // elsewhere on the page whose selectors had shifted looked new.
    let section = "";
    if (scope !== document.body) {
      section = scope.getAttribute("data-foray-section") || "";
      if (!section) {
        section = "s" + Math.random().toString(36).slice(2, 10);
        scope.setAttribute("data-foray-section", section);
      }
    }
    return [{
      content: text(scope).slice(0, 2000),
      heading: headingOf(scope) || (node.getAttribute("aria-label") || "").slice(0, 120),
      index,
      section,
      text: text(node).slice(0, 60),
    }];
  });
}, "${pageControlsLocator}");
return { sections };
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
    heading: heading.slice(0, 120),
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
const confirmedPattern = new RegExp(${JSON.stringify(submissionConfirmationText.source)}, "i");
const submittedUrl = new RegExp(${JSON.stringify(submissionUrlPattern.source)}, "i");
const describe = (error) => String(error && error.message || error).replace(/\\s+/g, " ").slice(0, 200);
const bodyText = () => page.locator("body").innerText({ timeout: 2000 })
  .then((text) => String(text || "").replace(/\\s+/g, " "))
  .catch(() => "");
// What is left of the form: controls a candidate could still fill and submit
// buttons inside a form. A confirmation page has neither.
const remains = () => page.evaluate(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const skip = new Set(["hidden", "submit", "button", "image", "checkbox", "radio", "search", "reset"]);
  let fields = 0;
  for (const node of document.querySelectorAll("input, textarea, select, [role=combobox]")) {
    const type = String(node.getAttribute("type") || node.tagName).toLowerCase();
    if (!skip.has(type) && visible(node)) fields += 1;
  }
  const submits = [...document.querySelectorAll("form button[type=submit], form input[type=submit]")].filter(visible).length;
  return { fields, submits };
}).catch(() => ({ fields: 99, submits: 99 }));
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
if (!button) return { clicked: false, errors: [], href: before, invalid: [], navigated: false, reason: "no_control" };
// Confirmation wording already on the page is the posting's own, never proof.
const confirmedBefore = confirmedPattern.test(await bodyText());
try {
  await button.click({ timeout: 8000 });
} catch (error) {
  return { clicked: false, errors: [describe(error)], href: page.url(), invalid: [], navigated: false, reason: "click_failed" };
}
await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
await page.waitForTimeout(500);
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
// Three signs the page took it, read from the same page the click went to:
// its address, its copy, and the form itself being gone. Any one of them is
// weighed by the caller against the page's complaints and any code dialog.
const href = page.url();
const confirmedText = !confirmedBefore && confirmedPattern.test(await bodyText());
const submitGone = !(await button.isVisible().catch(() => false));
const left = await remains();
const formGone = left.fields < 2 && left.submits === 0;
return {
  clicked: true,
  confirmedText,
  confirmedUrl: submittedUrl.test(href),
  errors: [...new Set(errors)],
  formGone,
  href,
  invalid: [...new Set(invalid)],
  navigated: href !== before,
  submitGone,
};
`;
