import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readCandidateProfile } from "@/db/services/candidate-profile";
import { scopeFromPrincipal } from "@/lib/access-scope";
import { findGoforayRoles, nextGoforayRoles } from "@/lib/goforay/bridge";
import {
  loadRoleSearchCriteria,
  storePresentedRoles,
  storeRoleSearchCriteria,
} from "@/lib/goforay/presented-roles";

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
 *
 * Both tools exclude roles the workspace has already been shown, and both drop
 * public hits that are not a single posting for the role asked for.
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
            "Immediately find roles whenever the user asks to find roles, show openings, or suggest jobs. Reuse their workspace profile plus any title, seniority, or location they stated. If the result has `needs`, ask one concise follow-up containing only those missing details; do not mention JuiceBox, candidate links, or CRM setup. Otherwise return the concrete cards. Search prefers curated JuiceBox matches when available and otherwise discovers live public postings through Exa; a candidate association is never required. This tool already excludes every role this workspace has been shown before, so it is also the right tool when the user asks for more, additional, other, or new roles. If the result has `exhausted`, say plainly there is nothing new for those criteria and offer to widen the title, seniority, or location; never pad the batch with a role from an earlier one. Never call web_search for the candidate's own role search, including when this tool fails or returns nothing. The client renders the cards; write at most one intro line and never paste this object or list the roles as bullets.",
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
            storeRoleSearchCriteria(criteria);
            const feed = await findGoforayRoles(scope, {
              query: criteria.query,
              location: criteria.location,
              limit,
              role: criteria.role,
              seniority: criteria.seniority,
            });
            storePresentedRoles(feed.cards);
            return feed;
          },
        }),
        find_next_goforay_roles: defineTool({
          description:
            "Continue the role search already in play: up to five more roles for the same criteria, excluding everything this candidate has already been shown. Use it when the user asks for more of the same search. If they name a new title, seniority, or location, call find_goforay_roles with those instead. Same output shape, and the same `exhausted` handling: if there is nothing new, say so rather than resending an earlier role.",
          inputSchema: roleSearchInputSchema.partial(),
          execute: async (input) => {
            // Restated details win; otherwise continue the search on screen.
            const previous = loadRoleSearchCriteria();
            const restatedQuery = input.query?.trim() ?? "";
            const feed = await nextGoforayRoles(scope, {
              query: restatedQuery || previous?.query,
              location: (input.location?.trim() ?? "") || previous?.location,
              limit: input.limit,
              role: restatedQuery || previous?.role,
              seniority: (input.seniority?.trim() ?? "") || previous?.seniority,
            });
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
    // `query` is the search string; `role` is the bare phrase the relevance
    // gate matches against a title, so seniority never becomes a requirement
    // a posting has to spell out.
    query: [seniority, role].filter(Boolean).join(" "),
    location,
    role,
    seniority: seniority ?? "",
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
