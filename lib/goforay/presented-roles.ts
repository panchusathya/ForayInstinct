import { defineState } from "eve/context";
import type { GoForayJobCard } from "./job-cards";

const presentedRoles = defineState(
  "foray.presented-roles",
  (): GoForayJobCard[] => []
);

/**
 * The criteria behind the batch on screen, so "find me more" continues the
 * same search. Without this, the follow-on tool searched with an empty query
 * and returned an unfiltered feed read.
 */
const lastRoleSearch = defineState(
  "foray.last-role-search",
  (): RoleSearchCriteria | undefined => undefined
);

export interface RoleSearchCriteria {
  query: string;
  location: string;
  role: string;
  seniority: string;
}

export function storeRoleSearchCriteria(criteria: RoleSearchCriteria) {
  lastRoleSearch.update(() => criteria);
}

export function loadRoleSearchCriteria() {
  return lastRoleSearch.get();
}

export interface ApplicationTargetInput {
  apply_url?: string;
  job_posting_id?: string;
  query?: string;
  selection?: number;
}

/** Last numbered batch shown this session. `apply 2` and "the toro one" resolve against it. */
export function storePresentedRoles(cards: GoForayJobCard[]) {
  presentedRoles.update(() => cards.slice(0, 5));
}

export function loadPresentedRoles() {
  return presentedRoles.get();
}

export function resolvePresentedRole(
  input: ApplicationTargetInput,
  cards: GoForayJobCard[]
): GoForayJobCard | undefined {
  if (input.job_posting_id) {
    const match = cards.find(
      (card) => card.posting_id === input.job_posting_id
    );
    if (match) return match;
  }
  if (input.selection) {
    const match = cards[input.selection - 1];
    if (match) return match;
  }
  const query = input.query?.trim().toLowerCase();
  if (query) {
    const match = cards.find((card) => roleMatchesQuery(card, query));
    if (match) return match;
  }
  if (input.apply_url) {
    const match = cards.find(
      (card) => card.url.toLowerCase() === input.apply_url?.toLowerCase()
    );
    if (match) return match;
    return {
      company: companyFromUrl(input.apply_url),
      location: "",
      reasons: [],
      title: "Open role",
      url: input.apply_url,
    };
  }
  if (input.job_posting_id && cards.length === 0) return undefined;
  return undefined;
}

function roleMatchesQuery(card: GoForayJobCard, query: string) {
  const haystack = `${card.company} ${card.title} ${card.url}`.toLowerCase();
  return query
    .split(/\s+/u)
    .filter((part) => part.length > 1)
    .every((part) => haystack.includes(part));
}

function companyFromUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./u, "");
    const parts = hostname.split(".");
    return parts.at(-2) ?? hostname;
  } catch {
    return "";
  }
}
