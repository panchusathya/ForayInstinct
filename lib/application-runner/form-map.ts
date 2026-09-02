import type {
  CandidateContactIdentity,
  CandidateProfile,
} from "@/lib/candidate-profile";

export interface VisibleFormField {
  label: string;
  name: string;
  required: boolean;
  selector: string;
  tag: string;
  type: string;
}

export interface MappedFill {
  selector: string;
  value: string;
}

const workAuthorizationLabels: Record<string, string> = {
  other: "Other",
  requires_sponsorship: "I will require sponsorship",
  us_citizen: "U.S. Citizen",
  us_permanent_resident: "Permanent Resident",
  us_visa_no_sponsorship: "Authorized to work, no sponsorship needed",
};

/**
 * Deterministic mapping from a candidate profile onto visible form controls.
 * Unmapped required fields are returned for the bounded LLM helper — never a
 * screenshot loop.
 */
export function mapProfileToFormFields(input: {
  fields: VisibleFormField[];
  identity: CandidateContactIdentity;
  profile: CandidateProfile;
  resumePath?: string;
}): { fills: MappedFill[]; unmapped: VisibleFormField[] } {
  const fills: MappedFill[] = [];
  const unmapped: VisibleFormField[] = [];
  for (const field of input.fields) {
    if (field.tag === "file" || field.type === "file") {
      if (input.resumePath) {
        fills.push({ selector: field.selector, value: input.resumePath });
      } else {
        unmapped.push(field);
      }
      continue;
    }
    const value = valueForField(field, input.profile, input.identity);
    if (value !== undefined && value !== "") {
      fills.push({ selector: field.selector, value });
    } else if (field.required) {
      unmapped.push(field);
    }
  }
  return { fills, unmapped };
}

function valueForField(
  field: VisibleFormField,
  profile: CandidateProfile,
  identity: CandidateContactIdentity
): string | undefined {
  const key = normalize(field.label, field.name, field.type);
  if (key.includes("email") || field.type === "email") return identity.email;
  if (/(mobile|phone|tel)/u.test(key) || field.type === "tel") {
    return identity.phone;
  }
  if (/first.?name|given.?name|legal.?first/u.test(key)) {
    return profile.legalFirstName;
  }
  if (/last.?name|family.?name|surname|legal.?last/u.test(key)) {
    return profile.legalLastName;
  }
  if (/preferred.?name|nickname/u.test(key)) {
    return profile.preferredName || profile.legalFirstName;
  }
  if (/^name$|full.?name|legal.?name/u.test(key)) {
    return [profile.legalFirstName, profile.legalLastName]
      .filter(Boolean)
      .join(" ");
  }
  if (/city/u.test(key)) return profile.locationCity;
  if (/state|region|province/u.test(key)) return profile.locationRegion;
  if (/zip|postal/u.test(key)) return profile.locationPostalCode;
  if (/country/u.test(key)) return profile.locationCountryCode;
  if (/linkedin/u.test(key)) {
    return profile.links.find((link) =>
      /linkedin/iu.test(link.label + link.url)
    )?.url;
  }
  if (/github/u.test(key)) {
    return profile.links.find((link) => /github/iu.test(link.label + link.url))
      ?.url;
  }
  if (/sponsor/u.test(key)) {
    return yesNo(profile.requiresSponsorshipNow);
  }
  if (/authoriz|work.?eligib|citizenship/u.test(key)) {
    return workAuthorizationLabels[profile.workAuthorization];
  }
  if (/relocat/u.test(key)) return yesNo(profile.willingToRelocate);
  if (/start.?date|earliest.?start|available/u.test(key)) {
    return profile.earliestStartDate;
  }
  if (/salary|compensation|pay.?expect/u.test(key)) {
    if (profile.salaryMin == null) return undefined;
    return String(profile.salaryMin);
  }
  if (/headline|title/u.test(key) && profile.headline) return profile.headline;
  return undefined;
}

function yesNo(value: string) {
  if (value === "yes") return "Yes";
  if (value === "no") return "No";
  return undefined;
}

function normalize(...parts: string[]) {
  return parts
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}
