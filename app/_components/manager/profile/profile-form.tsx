"use client";

import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { VaultFormField } from "@/app/_components/manager/vault-form-field";
import type {
  EducationEntry,
  ProfileLink,
  WorkHistoryEntry,
} from "@/lib/candidate-profile";
import { CandidateDocumentsPanel } from "./documents-panel";
import { useCandidateProfile } from "./use-candidate-profile";

type Keyed<T> = { readonly key: string; value: T };

export function CandidateProfileForm() {
  const { busy, error, save, signOutEverywhere, snapshot } =
    useCandidateProfile();

  if (!snapshot) {
    return (
      <main className="flex min-w-0 flex-col gap-8">
        <h1 className="sr-only">Profile</h1>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Profile unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </main>
    );
  }

  return (
    <ProfileEditor
      busy={busy}
      error={error}
      save={save}
      signOutEverywhere={signOutEverywhere}
      snapshot={snapshot}
    />
  );
}

function ProfileEditor({
  busy,
  error,
  save,
  signOutEverywhere,
  snapshot,
}: {
  readonly busy: boolean;
  readonly error?: string;
  readonly save: ReturnType<typeof useCandidateProfile>["save"];
  readonly signOutEverywhere: ReturnType<
    typeof useCandidateProfile
  >["signOutEverywhere"];
  readonly snapshot: NonNullable<
    ReturnType<typeof useCandidateProfile>["snapshot"]
  >;
}) {
  const [form, setForm] = useState(snapshot.profile);
  const [workHistory, setWorkHistory] = useState(() =>
    withKeys(snapshot.profile.workHistory)
  );
  const [education, setEducation] = useState(() =>
    withKeys(snapshot.profile.education)
  );
  const [links, setLinks] = useState(() => withKeys(snapshot.profile.links));
  const [skillDraft, setSkillDraft] = useState("");
  const [saved, setSaved] = useState(false);

  const submit = async () => {
    setSaved(false);
    const ok = await save({
      ...form,
      education: education.map((entry) => entry.value),
      links: links.map((entry) => entry.value),
      workHistory: workHistory.map((entry) => entry.value),
    });
    if (ok) setSaved(true);
  };

  return (
    <main className="flex min-w-0 flex-col gap-8">
      <h1 className="sr-only">Profile</h1>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Profile unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {snapshot?.identity.email || snapshot?.identity.phone ? (
        <p className="type-supporting-body text-muted-foreground">
          {[snapshot.identity.email, snapshot.identity.phone]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}

      <Section title="Identity">
        <div className="grid gap-3 sm:grid-cols-3">
          <VaultFormField
            id="profile-legal-first"
            label="Legal first name"
            onChange={(legalFirstName) =>
              setForm((current) => ({ ...current, legalFirstName }))
            }
            value={form.legalFirstName}
          />
          <VaultFormField
            id="profile-legal-last"
            label="Legal last name"
            onChange={(legalLastName) =>
              setForm((current) => ({ ...current, legalLastName }))
            }
            value={form.legalLastName}
          />
          <VaultFormField
            id="profile-preferred"
            label="Preferred name"
            onChange={(preferredName) =>
              setForm((current) => ({ ...current, preferredName }))
            }
            value={form.preferredName}
          />
        </div>
      </Section>

      <Section title="Location">
        <div className="grid gap-3 sm:grid-cols-2">
          <VaultFormField
            id="profile-city"
            label="City"
            onChange={(locationCity) =>
              setForm((current) => ({ ...current, locationCity }))
            }
            value={form.locationCity}
          />
          <VaultFormField
            id="profile-region"
            label="Region / state"
            onChange={(locationRegion) =>
              setForm((current) => ({ ...current, locationRegion }))
            }
            value={form.locationRegion}
          />
          <VaultFormField
            id="profile-postal"
            label="Postal code"
            onChange={(locationPostalCode) =>
              setForm((current) => ({ ...current, locationPostalCode }))
            }
            value={form.locationPostalCode}
          />
          <VaultFormField
            id="profile-country"
            label="Country code"
            onChange={(locationCountryCode) =>
              setForm((current) => ({
                ...current,
                locationCountryCode: locationCountryCode.toUpperCase(),
              }))
            }
            placeholder="US"
            value={form.locationCountryCode}
          />
        </div>
      </Section>

      <Section title="Work authorization">
        <div className="grid gap-3 sm:grid-cols-3">
          <EnumField
            id="profile-authorization"
            label="Work authorization"
            onChange={(workAuthorization) =>
              setForm((current) => ({ ...current, workAuthorization }))
            }
            options={authorizationOptions}
            value={form.workAuthorization}
          />
          <EnumField
            id="profile-sponsorship-now"
            label="Sponsorship now"
            onChange={(requiresSponsorshipNow) =>
              setForm((current) => ({ ...current, requiresSponsorshipNow }))
            }
            options={yesNoOptions}
            value={form.requiresSponsorshipNow}
          />
          <EnumField
            id="profile-sponsorship-future"
            label="Sponsorship in the future"
            onChange={(requiresSponsorshipFuture) =>
              setForm((current) => ({
                ...current,
                requiresSponsorshipFuture,
              }))
            }
            options={yesNoOptions}
            value={form.requiresSponsorshipFuture}
          />
        </div>
      </Section>

      <Section title="Compensation">
        <div className="grid gap-3 sm:grid-cols-4">
          <NumberField
            id="profile-salary-min"
            label="Minimum"
            onChange={(salaryMin) =>
              setForm((current) => ({ ...current, salaryMin }))
            }
            value={form.salaryMin}
          />
          <NumberField
            id="profile-salary-max"
            label="Maximum"
            onChange={(salaryMax) =>
              setForm((current) => ({ ...current, salaryMax }))
            }
            value={form.salaryMax}
          />
          <VaultFormField
            id="profile-salary-currency"
            label="Currency"
            onChange={(salaryCurrency) =>
              setForm((current) => ({ ...current, salaryCurrency }))
            }
            value={form.salaryCurrency}
          />
          <EnumField
            id="profile-salary-period"
            label="Period"
            onChange={(salaryPeriod) =>
              setForm((current) => ({ ...current, salaryPeriod }))
            }
            options={periodOptions}
            value={form.salaryPeriod}
          />
        </div>
      </Section>

      <Section title="Availability">
        <div className="grid gap-3 sm:grid-cols-3">
          <VaultFormField
            id="profile-start"
            label="Earliest start"
            onChange={(earliestStartDate) =>
              setForm((current) => ({ ...current, earliestStartDate }))
            }
            placeholder="ASAP"
            value={form.earliestStartDate}
          />
          <EnumField
            id="profile-relocate"
            label="Willing to relocate"
            onChange={(willingToRelocate) =>
              setForm((current) => ({ ...current, willingToRelocate }))
            }
            options={yesNoOptions}
            value={form.willingToRelocate}
          />
          <EnumField
            id="profile-arrangement"
            label="Work arrangement"
            onChange={(workArrangement) =>
              setForm((current) => ({ ...current, workArrangement }))
            }
            options={arrangementOptions}
            value={form.workArrangement}
          />
        </div>
      </Section>

      <Section title="Narrative">
        <FieldGroup className="gap-3">
          <VaultFormField
            id="profile-headline"
            label="Headline"
            onChange={(headline) =>
              setForm((current) => ({ ...current, headline }))
            }
            value={form.headline}
          />
          <NumberField
            id="profile-years"
            label="Years of experience"
            onChange={(yearsExperience) =>
              setForm((current) => ({ ...current, yearsExperience }))
            }
            value={form.yearsExperience}
          />
          <Field>
            <FieldLabel htmlFor="profile-summary">Summary</FieldLabel>
            <Textarea
              id="profile-summary"
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  summary: event.target.value,
                }))
              }
              rows={5}
              value={form.summary}
            />
          </Field>
        </FieldGroup>
      </Section>

      <Section title="Skills">
        <div className="flex flex-wrap gap-2">
          {form.skills.map((skill) => (
            <Badge key={skill} variant="secondary">
              {skill}
              <button
                aria-label={`Remove ${skill}`}
                className="ml-1"
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    skills: current.skills.filter((entry) => entry !== skill),
                  }))
                }
                type="button"
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const skill = skillDraft.trim();
            if (!skill || form.skills.includes(skill)) return;
            setForm((current) => ({
              ...current,
              skills: [...current.skills, skill],
            }));
            setSkillDraft("");
          }}
        >
          <Input
            aria-label="Add a skill"
            onChange={(event) => setSkillDraft(event.target.value)}
            placeholder="Add a skill"
            value={skillDraft}
          />
          <Button type="submit" variant="outline">
            Add
          </Button>
        </form>
      </Section>

      <Section
        onAdd={() => setLinks((current) => [...current, keyed(emptyLink())])}
        title="Links"
      >
        <KeyedList
          items={links}
          onChange={setLinks}
          render={(entry, update) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <VaultFormField
                id={`${entry.key}-label`}
                label="Label"
                onChange={(label) => update({ ...entry.value, label })}
                value={entry.value.label}
              />
              <VaultFormField
                id={`${entry.key}-url`}
                label="URL"
                onChange={(url) => update({ ...entry.value, url })}
                value={entry.value.url}
              />
            </div>
          )}
        />
      </Section>

      <Section
        onAdd={() =>
          setWorkHistory((current) => [...current, keyed(emptyWork())])
        }
        title="Work history"
      >
        <KeyedList
          items={workHistory}
          onChange={setWorkHistory}
          render={(entry, update) => (
            <WorkHistoryFields entry={entry} onChange={update} />
          )}
        />
      </Section>

      <Section
        onAdd={() =>
          setEducation((current) => [...current, keyed(emptyEducation())])
        }
        title="Education"
      >
        <KeyedList
          items={education}
          onChange={setEducation}
          render={(entry, update) => (
            <EducationFields entry={entry} onChange={update} />
          )}
        />
      </Section>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} onClick={() => void submit()} type="button">
          Save profile
        </Button>
        {saved ? (
          <p className="type-supporting-body text-muted-foreground">Saved.</p>
        ) : null}
      </div>

      <CandidateDocumentsPanel />

      <section className="space-y-3 border-t border-border/50 pt-6">
        <h2 className="type-caption text-muted-foreground uppercase">
          Saved browser sessions
        </h2>
        <p className="type-supporting-body text-muted-foreground">
          Sign out everywhere deletes the saved browser profile so the next
          application starts unsigned-in. It does not delete vault logins.
        </p>
        <Button
          disabled={busy || !snapshot?.kernelProfileId}
          onClick={() => void signOutEverywhere()}
          type="button"
          variant="outline"
        >
          Sign out everywhere
        </Button>
      </section>
    </main>
  );
}

function Section({
  children,
  onAdd,
  title,
}: {
  readonly children: React.ReactNode;
  readonly onAdd?: () => void;
  readonly title: string;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="type-caption text-muted-foreground uppercase">
          {title}
        </h2>
        {onAdd ? (
          <Button onClick={onAdd} size="sm" type="button" variant="ghost">
            <PlusIcon />
            Add
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function KeyedList<T>({
  items,
  onChange,
  render,
}: {
  readonly items: Keyed<T>[];
  readonly onChange: (items: Keyed<T>[]) => void;
  readonly render: (
    entry: Keyed<T>,
    update: (value: T) => void
  ) => React.ReactNode;
}) {
  return (
    <div className="divide-y divide-border/50 border-y border-border/50">
      {items.map((entry, index) => (
        <div className="flex gap-3 py-3" key={entry.key}>
          <div className="min-w-0 flex-1">
            {render(entry, (value) =>
              onChange(
                items.map((item) =>
                  item.key === entry.key ? { ...item, value } : item
                )
              )
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Button
              aria-label="Move up"
              disabled={index === 0}
              onClick={() => onChange(move(items, index, -1))}
              size="icon-sm"
              type="button"
              variant="quiet"
            >
              <ArrowUpIcon />
            </Button>
            <Button
              aria-label="Move down"
              disabled={index === items.length - 1}
              onClick={() => onChange(move(items, index, 1))}
              size="icon-sm"
              type="button"
              variant="quiet"
            >
              <ArrowDownIcon />
            </Button>
            <Button
              aria-label="Remove"
              onClick={() =>
                onChange(items.filter((item) => item.key !== entry.key))
              }
              size="icon-sm"
              type="button"
              variant="quiet"
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function WorkHistoryFields({
  entry,
  onChange,
}: {
  readonly entry: Keyed<WorkHistoryEntry>;
  readonly onChange: (value: WorkHistoryEntry) => void;
}) {
  const value = entry.value;
  return (
    <FieldGroup className="gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <VaultFormField
          id={`${entry.key}-title`}
          label="Title"
          onChange={(title) => onChange({ ...value, title })}
          value={value.title}
        />
        <VaultFormField
          id={`${entry.key}-company`}
          label="Company"
          onChange={(company) => onChange({ ...value, company })}
          value={value.company}
        />
      </div>
      <VaultFormField
        id={`${entry.key}-location`}
        label="Location"
        onChange={(location) => onChange({ ...value, location })}
        value={value.location}
      />
      <DateRangeFields idPrefix={entry.key} onChange={onChange} value={value} />
      <Field>
        <FieldLabel htmlFor={`${entry.key}-description`}>
          Description
        </FieldLabel>
        <Textarea
          id={`${entry.key}-description`}
          onChange={(event) =>
            onChange({ ...value, description: event.target.value })
          }
          rows={3}
          value={value.description}
        />
      </Field>
    </FieldGroup>
  );
}

function EducationFields({
  entry,
  onChange,
}: {
  readonly entry: Keyed<EducationEntry>;
  readonly onChange: (value: EducationEntry) => void;
}) {
  const value = entry.value;
  return (
    <FieldGroup className="gap-3">
      <VaultFormField
        id={`${entry.key}-school`}
        label="School"
        onChange={(school) => onChange({ ...value, school })}
        value={value.school}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <VaultFormField
          id={`${entry.key}-degree`}
          label="Degree"
          onChange={(degree) => onChange({ ...value, degree })}
          value={value.degree}
        />
        <VaultFormField
          id={`${entry.key}-field`}
          label="Field"
          onChange={(field) => onChange({ ...value, field })}
          value={value.field}
        />
      </div>
      <DateRangeFields idPrefix={entry.key} onChange={onChange} value={value} />
    </FieldGroup>
  );
}

function DateRangeFields<
  T extends {
    readonly current: boolean;
    readonly endMonth?: number;
    readonly endYear?: number;
    readonly startMonth?: number;
    readonly startYear?: number;
  },
>({
  idPrefix,
  onChange,
  value,
}: {
  readonly idPrefix: string;
  readonly onChange: (value: T) => void;
  readonly value: T;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-5">
      <NumberField
        id={`${idPrefix}-start-month`}
        label="Start month"
        max={12}
        min={1}
        onChange={(startMonth) =>
          onChange({ ...value, startMonth: startMonth ?? undefined })
        }
        value={value.startMonth ?? null}
      />
      <NumberField
        id={`${idPrefix}-start-year`}
        label="Start year"
        onChange={(startYear) =>
          onChange({ ...value, startYear: startYear ?? undefined })
        }
        value={value.startYear ?? null}
      />
      <NumberField
        id={`${idPrefix}-end-month`}
        label="End month"
        max={12}
        min={1}
        onChange={(endMonth) =>
          onChange({ ...value, endMonth: endMonth ?? undefined })
        }
        value={value.endMonth ?? null}
      />
      <NumberField
        id={`${idPrefix}-end-year`}
        label="End year"
        onChange={(endYear) =>
          onChange({ ...value, endYear: endYear ?? undefined })
        }
        value={value.endYear ?? null}
      />
      <label className="flex items-end gap-2 pb-2 type-label">
        <input
          checked={value.current}
          onChange={(event) =>
            onChange({ ...value, current: event.target.checked })
          }
          type="checkbox"
        />
        Current
      </label>
    </div>
  );
}

function EnumField<T extends string>({
  id,
  label,
  onChange,
  options,
  value,
}: {
  readonly id: string;
  readonly label: string;
  readonly onChange: (value: T) => void;
  readonly options: readonly { readonly label: string; readonly value: T }[];
  readonly value: T;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        onValueChange={(next) => {
          const resolved = (next === "__blank__" ? "" : next) as T;
          const match = options.find((option) => option.value === resolved);
          if (match) onChange(match.value);
        }}
        value={value || "__blank__"}
      >
        <SelectTrigger className="w-full" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value || "__blank__"}
              value={option.value || "__blank__"}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function NumberField({
  id,
  label,
  max,
  min,
  onChange,
  value,
}: {
  readonly id: string;
  readonly label: string;
  readonly max?: number;
  readonly min?: number;
  readonly onChange: (value: number | null) => void;
  readonly value: number | null;
}) {
  return (
    <VaultFormField
      id={id}
      inputMode="numeric"
      label={label}
      onChange={(next) => {
        if (next.trim() === "") {
          onChange(null);
          return;
        }
        const parsed = Number.parseInt(next, 10);
        onChange(Number.isNaN(parsed) ? null : parsed);
      }}
      value={value === null ? "" : String(value)}
      {...(max === undefined ? {} : { max })}
      {...(min === undefined ? {} : { min })}
    />
  );
}

const authorizationOptions = [
  { label: "Not set", value: "" },
  { label: "US citizen", value: "us_citizen" },
  { label: "US permanent resident", value: "us_permanent_resident" },
  { label: "US visa, no sponsorship", value: "us_visa_no_sponsorship" },
  { label: "Requires sponsorship", value: "requires_sponsorship" },
  { label: "Other", value: "other" },
] as const;

const yesNoOptions = [
  { label: "Not set", value: "" },
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
] as const;

const periodOptions = [
  { label: "Not set", value: "" },
  { label: "Year", value: "year" },
  { label: "Hour", value: "hour" },
] as const;

const arrangementOptions = [
  { label: "Not set", value: "" },
  { label: "Remote", value: "remote" },
  { label: "Hybrid", value: "hybrid" },
  { label: "Onsite", value: "onsite" },
  { label: "Flexible", value: "flexible" },
] as const;

function withKeys<T>(items: readonly T[]): Keyed<T>[] {
  return items.map((value) => keyed(value));
}

function keyed<T>(value: T): Keyed<T> {
  return { key: crypto.randomUUID(), value };
}

function move<T>(items: T[], index: number, delta: number) {
  const next = index + delta;
  if (next < 0 || next >= items.length) return items;
  const copy = [...items];
  const [removed] = copy.splice(index, 1);
  if (removed === undefined) return items;
  copy.splice(next, 0, removed);
  return copy;
}

function emptyLink(): ProfileLink {
  return { label: "", url: "" };
}

function emptyWork(): WorkHistoryEntry {
  return {
    company: "",
    current: false,
    description: "",
    location: "",
    title: "",
  };
}

function emptyEducation(): EducationEntry {
  return {
    current: false,
    degree: "",
    field: "",
    school: "",
  };
}
