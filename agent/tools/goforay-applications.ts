import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { scopeFromPrincipal } from "@/lib/access-scope";
import { findGoforayRoles, nextGoforayRoles } from "@/lib/goforay/bridge";

/**
 * Coordinator tools for roles. Applying is a worker assignment against the
 * card's URL, not a JuiceBox application-task wrapper.
 *
 * Typical call order after "find me jobs":
 * 1. `find_goforay_roles` → JuiceBox GET /job-feed (queues Exa if empty)
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
            "Immediately find roles whenever the user asks to find roles, show openings, or suggest jobs. This is JuiceBox's job book: curated matches first, and if the book is empty JuiceBox queues the same Exa discovery the messaging bot uses. Never search Exa yourself and never call web_search for this. Present cards to the user as short bullets only when the channel did not already deliver them; never paste this object. If `searching` is true and cards are empty, say JuiceBox is looking now. If `unavailable` is set, say role search is down.",
          inputSchema: z.object({
            query: z.string().max(120).optional(),
            location: z.string().max(120).optional(),
            limit: z.number().int().min(1).max(10).default(5),
          }),
          execute: ({ query, location, limit }) =>
            findGoforayRoles(scope, { query, location, limit }),
        }),
        find_next_goforay_roles: defineTool({
          description:
            "Immediately after sending the worker to apply, fetch up to five new curated JuiceBox roles for the same candidate. The started and previously shown roles are excluded. Never claim there are roles when the returned list is empty.",
          inputSchema: z.object({}),
          execute: () => nextGoforayRoles(scope),
        }),
      };
    },
  },
});
