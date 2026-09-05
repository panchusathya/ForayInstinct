import { z } from "zod";
import { applicationExecutionLog } from "@/lib/application-execution";
import { suggestUnmappedFills } from "@/lib/application-runner/ambiguous";
import type {
  MappedFill,
  VisibleFormField,
} from "@/lib/application-runner/form-map";
import { clickControl } from "@/lib/application-runner/navigate";
import {
  applyFillsCode,
  collectRepeaterSectionsCode,
  collectVisibleFieldsCode,
} from "@/lib/application-runner/playwright-scripts";
import { browserProvider } from "@/lib/browser";
import {
  type CandidateProfile,
  type EducationEntry,
  formatProfileEntry,
  type WorkHistoryEntry,
} from "@/lib/candidate-profile";

const sectionSchema = z.object({
  content: z.string().default(""),
  heading: z.string().default(""),
  index: z.number().int().min(0),
  text: z.string(),
});

type RepeaterSection = z.infer<typeof sectionSchema>;

const fieldSchema = z.object({
  label: z.string(),
  name: z.string(),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
  selector: z.string(),
  tag: z.string(),
  type: z.string(),
});

/** How many entries a form is given, whatever the profile holds. */
const maxWorkEntries = 5;
const maxEducationEntries = 3;

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type ProfileEntry = WorkHistoryEntry | EducationEntry;

/** The profile entries a repeating section takes, by its heading. */
function entriesForSection(
  wording: string,
  profile: CandidateProfile
): ProfileEntry[] | undefined {
  if (
    /experience|employment|work history|\bjob|position|career/iu.test(wording)
  ) {
    return profile.workHistory.slice(0, maxWorkEntries);
  }
  if (/education|school|degree|academic|university/iu.test(wording)) {
    return profile.education.slice(0, maxEducationEntries);
  }
  return undefined;
}

/** The word on the page that shows an entry is already there. */
function entryKey(entry: ProfileEntry) {
  return ("company" in entry ? entry.company : entry.school).trim();
}

const isDateField = (field: VisibleFormField) =>
  /month|year|date|\bfrom\b|\bto\b|start|end/iu.test(field.label) ||
  ["date", "month"].includes(field.type);

function monthFill(selector: string, month: number): MappedFill {
  const name = monthNames[month - 1] ?? String(month);
  const padded = String(month).padStart(2, "0");
  return {
    alternatives: [padded, String(month), name.slice(0, 3)],
    selector,
    value: name,
  };
}

function dateFill(
  field: VisibleFormField,
  month: number | undefined,
  year: number | undefined
): MappedFill | undefined {
  if (year === undefined) return undefined;
  const yyyy = String(year);
  const mm = String(month ?? 1).padStart(2, "0");
  if (field.type === "month")
    return { selector: field.selector, value: `${yyyy}-${mm}` };
  if (field.type === "date") {
    return { selector: field.selector, value: `${yyyy}-${mm}-01` };
  }
  return {
    alternatives: [
      `${mm}/01/${yyyy}`,
      `${monthNames[Number(mm) - 1] ?? mm} ${yyyy}`,
      yyyy,
    ],
    selector: field.selector,
    value: `${mm}/${yyyy}`,
  };
}

/**
 * Maps the controls of one freshly added block onto one profile entry by
 * label. Dates are the fiddly part: a block may take month and year apart,
 * one date control, or free text, and may or may not say start and end in
 * the labels, so unlabelled date controls are taken in page order, start
 * first. A current position ticks the page's "currently here" box and leaves
 * the end date alone. Anything unmatched is returned for the helper.
 */
export function mapEntryToBlock(
  block: VisibleFormField[],
  entry: ProfileEntry
): { fills: MappedFill[]; leftover: VisibleFormField[] } {
  const fills: MappedFill[] = [];
  const leftover: VisibleFormField[] = [];
  const dateFields: VisibleFormField[] = [];
  const work = "company" in entry ? entry : undefined;
  const education = "company" in entry ? undefined : entry;
  const textFor = (label: string): string | undefined => {
    if (work) {
      if (
        /description|responsibilit|duties|summary|accomplishment/iu.test(label)
      ) {
        return work.description;
      }
      if (
        /job title|^title\b|position title|^(?:role|position)\*?$/iu.test(label)
      ) {
        return work.title;
      }
      if (/company|employer|organi[sz]ation|business/iu.test(label)) {
        return work.company;
      }
      if (/location|city|where/iu.test(label)) return work.location;
    }
    if (education) {
      if (/school|university|college|institution/iu.test(label))
        return education.school;
      if (/degree|qualification|credential/iu.test(label))
        return education.degree;
      if (
        /field of study|major|discipline|concentration|subject|program/iu.test(
          label
        )
      ) {
        return education.field;
      }
    }
    return undefined;
  };
  for (const field of block) {
    if (field.tag === "file") continue;
    if (field.tag === "checkbox" || field.type === "checkbox") {
      if (/current|present|still|ongoing/iu.test(field.label)) {
        fills.push({
          selector: field.selector,
          value: entry.current ? "yes" : "no",
        });
      } else {
        leftover.push(field);
      }
      continue;
    }
    if (isDateField(field)) {
      dateFields.push(field);
      continue;
    }
    const value = textFor(field.label);
    if (value !== undefined && value !== "")
      fills.push({ selector: field.selector, value });
    else leftover.push(field);
  }
  const starts = dateFields.filter((field) =>
    /start|from|begin/iu.test(field.label)
  );
  const ends = dateFields.filter((field) =>
    /end|\bto\b|until|finish|complet|graduat/iu.test(field.label)
  );
  const unnamed = dateFields.filter(
    (field) => !starts.includes(field) && !ends.includes(field)
  );
  // Unnamed date controls in page order: start first, then end.
  const half = Math.ceil(unnamed.length / 2);
  starts.push(...unnamed.slice(0, half));
  ends.push(...unnamed.slice(half));
  const place = (
    fieldsOfSide: VisibleFormField[],
    month: number | undefined,
    year: number | undefined,
    skip: boolean
  ) => {
    for (const field of fieldsOfSide) {
      if (skip) continue;
      const wantsMonth =
        /month/iu.test(field.label) ||
        (field.options ?? []).some((option) =>
          /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/iu.test(option)
        );
      const wantsYear = /year/iu.test(field.label) && !wantsMonth;
      if (wantsMonth) {
        if (month !== undefined) fills.push(monthFill(field.selector, month));
        else leftover.push(field);
      } else if (wantsYear) {
        if (year !== undefined)
          fills.push({ selector: field.selector, value: String(year) });
        else leftover.push(field);
      } else {
        const fill = dateFill(field, month, year);
        if (fill) fills.push(fill);
        else leftover.push(field);
      }
    }
  };
  place(starts, entry.startMonth, entry.startYear, false);
  place(ends, entry.endMonth, entry.endYear, entry.current);
  return { fills, leftover };
}

/**
 * Fills a page's repeating sections from the profile: one Add press per
 * work or education entry, the block of controls that appeared mapped from
 * that entry by label, and what the labels did not settle put to one bounded
 * helper call over that single entry. An entry whose company or school the
 * section already shows is skipped, so a page filled again after a pause does
 * not double up. A section whose heading names nothing the profile holds is
 * left alone and logged. Returns every control the page gained.
 */
export async function fillRepeaters(input: {
  applyUrl: string;
  browserSessionId: string;
  executionId: string;
  fieldsBefore: VisibleFormField[];
  profile: CandidateProfile;
}): Promise<VisibleFormField[]> {
  const sections = await readSections(input.browserSessionId);
  const known = new Set(input.fieldsBefore.map((field) => field.selector));
  const added: VisibleFormField[] = [];
  for (const section of sections) {
    const entries = entriesForSection(
      `${section.heading} ${section.text}`,
      input.profile
    );
    if (entries === undefined) {
      applicationExecutionLog({
        apply_url: input.applyUrl,
        control: section.text,
        event: "runner.repeater_skipped",
        execution_id: input.executionId,
        heading: section.heading,
      });
      continue;
    }
    for (const [position, entry] of entries.entries()) {
      // Read again each time: the last Add moved the control's index and put
      // the new entry's text into the section.
      const current = (await readSections(input.browserSessionId)).find(
        (candidate) =>
          candidate.heading === section.heading &&
          candidate.text === section.text
      );
      if (!current) break;
      const key = entryKey(entry);
      if (
        key !== "" &&
        current.content.toLowerCase().includes(key.toLowerCase())
      )
        continue;
      const outcome = await clickControl(input.browserSessionId, {
        disabled: false,
        href: "",
        index: current.index,
        text: current.text,
      });
      const after = await readFields(input.browserSessionId);
      const block = after.filter((field) => !known.has(field.selector));
      for (const field of block) known.add(field.selector);
      added.push(...block);
      const { fills, leftover } =
        block.length > 0
          ? mapEntryToBlock(block, entry)
          : { fills: [], leftover: [] };
      let helperFills = 0;
      if (fills.length > 0) await apply(input.browserSessionId, fills);
      const askable = leftover.filter(
        (field) => field.label.trim().length >= 2
      );
      if (askable.length > 0) {
        const helper = await suggestUnmappedFills({
          fields: askable,
          profileSummary: formatProfileEntry(entry),
        }).catch(() => ({ blockers: [], fills: [] }));
        helperFills = helper.fills.length;
        if (helperFills > 0) await apply(input.browserSessionId, helper.fills);
      }
      applicationExecutionLog({
        apply_url: input.applyUrl,
        clicked: outcome.clicked,
        control: current.text,
        entry: position + 1,
        event: "runner.repeater",
        execution_id: input.executionId,
        fields: block.length,
        heading: current.heading,
        helper: helperFills,
        mapped: fills.length,
      });
      // An Add that added nothing is a section that will not grow.
      if (block.length === 0) break;
    }
  }
  return added;
}

async function readSections(sessionId: string): Promise<RepeaterSection[]> {
  const response = await browserProvider.executePlaywright(sessionId, {
    code: collectRepeaterSectionsCode,
  });
  const parsed = z
    .object({ sections: z.array(sectionSchema) })
    .safeParse(response.result);
  return parsed.success ? parsed.data.sections : [];
}

async function readFields(sessionId: string): Promise<VisibleFormField[]> {
  const response = await browserProvider.executePlaywright(sessionId, {
    code: collectVisibleFieldsCode,
  });
  const parsed = z
    .object({ fields: z.array(fieldSchema) })
    .safeParse(response.result);
  return parsed.success ? parsed.data.fields : [];
}

async function apply(sessionId: string, fills: MappedFill[]) {
  const response = await browserProvider.executePlaywright(sessionId, {
    code: applyFillsCode(fills),
  });
  const parsed = z
    .object({
      skipped: z
        .array(z.object({ reason: z.string(), selector: z.string() }))
        .default([]),
    })
    .safeParse(response.result);
  for (const row of parsed.success ? parsed.data.skipped : []) {
    if (row.reason === "no-option") continue;
    applicationExecutionLog({
      event: "runner.fill_skipped",
      reason: row.reason.slice(0, 200),
      selector: row.selector,
    });
  }
}
