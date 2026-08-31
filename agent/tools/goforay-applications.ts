import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readCandidateProfile } from "@/db/services/candidate-profile";
import { scopeFromPrincipal } from "@/lib/access-scope";
import { findGoforayRoles, nextGoforayRoles } from "@/lib/goforay/bridge";
import { storePresentedRoles } from "@/lib/goforay/presented-roles";

const roleSearchInputSchema = z.object({
  query: z.string().max(120).optional(),
  location: z.string().max(120).optional(),
  seniority: z.string().max(80).optional(),
  limit: z.number().int().min(1).max(10).default(5),
});

/**
 * Coordinator tools for roles. Applying is a worker assignment against the
 * card's URL, not a JuiceBox application-task wrapper.
 *
 * Typical call order after "find me jobs":
 * 1. `find_goforay_roles` → curated JuiceBox roles or public Exa discovery
 * 2. Candidate picks a role (`apply 2` or a pasted URL)
 * 3. `worker` against that apply URL with the default resume
 * 4. `find_next_goforay_roles` in the same turn
 */

export default defineDynamic({
  events: {
    "step.started": (_event, context) => {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      if (!caller) return null;
      const scope = scopeFromPrincipal(caller);

      return {
        find_goforay_roles: defineTool({
          description:
            "Immediately find roles whenever the user asks to find roles, show openings, or suggest jobs. Reuse their workspace profile plus any title, seniority, or location they stated. If the result has `needs`, ask one concise follow-up containing only those missing details; do not mention JuiceBox, candidate links, or CRM setup. Otherwise return the concrete cards. Search prefers curated JuiceBox matches when available and otherwise discovers live public postings through Exa; a candidate association is never required. Never call web_search for the candidate's own role search. The client renders the cards; write at most one intro line and never paste this object or list the roles as bullets.",
          inputSchema: roleSearchInputSchema,
          execute: async ({ query, location, seniority, limit }) => {
            const profile = await readCandidateProfile(scope);
            const criteria = roleSearchCriteria(
              { query, location, seniority },
              profile
            );
            if (criteria.needs.length) {
              return {
                cards: [],
                needs: criteria.needs,
                searching: false,
                source: "profile",
              };
            }
            const feed = await findGoforayRoles(scope, {
              query: criteria.query,
              location: criteria.location,
              limit,
            });
            storePresentedRoles(feed.cards);
            return feed;
          },
        }),
        find_next_goforay_roles: defineTool({
          description:
            "Fetch up to five additional curated JuiceBox roles only when the user asks for more roles. Do not call this automatically after an application; the main role-search tool works without a CRM candidate association.",
          inputSchema: z.object({}),
          execute: async () => {
            const feed = await nextGoforayRoles(scope);
            storePresentedRoles(feed.cards);
            return feed;
          },
        }),
      };
    },
  },
});

function roleSearchCriteria(
  input: Omit<z.infer<typeof roleSearchInputSchema>, "limit">,
  profile: Awaited<ReturnType<typeof readCandidateProfile>>
) {
  const inferredRole =
    profile.headline ||
    profile.workHistory
      .map((position) => position.title)
      .filter(Boolean)
      .slice(0, 2)
      .join(" ");
  const role = input.query?.trim() || inferredRole;
  const seniority = input.seniority?.trim() || inferredSeniority(profile);
  const location =
    input.location?.trim() ||
    [profile.locationCity, profile.locationRegion, profile.locationCountryCode]
      .filter(Boolean)
      .join(", ");
  const needs = [
    ...(role ? [] : ["target role"]),
    ...(seniority ? [] : ["seniority"]),
    ...(location ? [] : ["preferred location"]),
  ];
  return {
    needs,
    query: [seniority, role].filter(Boolean).join(" "),
    location,
  };
}

function inferredSeniority(
  profile: Awaited<ReturnType<typeof readCandidateProfile>>
) {
  const title = [
    profile.headline,
    ...profile.workHistory.map((entry) => entry.title),
  ]
    .filter(Boolean)
    .join(" ");
  return title.match(
    /\b(?:intern|junior|senior|staff|lead|principal|manager|director|vice president|vp|head|chief)\b/iu
  )?.[0];
}
