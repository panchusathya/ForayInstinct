import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { scopeFromPrincipal } from "@/lib/access-scope";
import {
  applicationTask,
  findGoforayRoles,
  nextGoforayRoles,
  reportApplicationTask,
} from "@/lib/goforay/bridge";
import {
  loadPresentedRoles,
  storePresentedRoles,
} from "@/lib/goforay/presented-roles";
import { startPresentedApplication } from "@/lib/goforay/start-application";

/**
 * Coordinator tools for a candidate application fill.
 *
 * Typical call order after "apply to this role":
 * 1. `start_goforay_application` → posting_id, selection, query, or apply_url
 * 2. `worker` immediately, with the returned apply_url
 * 3. Worker: manage_browsers.create → stage resume → Playwright/computer fill
 * 4. `report_goforay_application_result` only when a JuiceBox task exists
 *
 * `get_goforay_application_task` is optional extra context, not a start gate.
 */

const taskId = z.string().min(1).max(80);

const applicationTargetSchema = z
  .object({
    apply_url: z.url().optional(),
    job_posting_id: z.uuid().optional(),
    query: z.string().max(120).optional(),
    selection: z.number().int().min(1).max(10).optional(),
  })
  .refine(
    (value) =>
      Boolean(
        value.apply_url ||
          value.job_posting_id ||
          value.query ||
          value.selection
      ),
    { message: "Pass job_posting_id, apply_url, selection, or query." }
  );

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
            "Immediately find roles whenever the user asks to find roles, show openings, or suggest jobs. This first returns actionable JuiceBox matches. If none exist or the candidate is new, it searches Exa for live public openings and returns those in the same conversation. Every card includes an apply URL. Never promise a future delivery. Only JuiceBox cards contain a posting_id. The channel delivers numbered cards with the apply URL; never paste this object.",
          inputSchema: z.object({
            query: z.string().max(120).optional(),
            location: z.string().max(120).optional(),
            limit: z.number().int().min(1).max(10).default(5),
          }),
          execute: async ({ query, location, limit }) => {
            const feed = await findGoforayRoles(scope, {
              query,
              location,
              limit,
            });
            storePresentedRoles(feed.cards);
            return feed;
          },
        }),
        start_goforay_application: defineTool({
          description:
            "Start exactly one application for the role the candidate asked to apply to. Pass job_posting_id for a JuiceBox card, or selection (the card number), query (company or title), or apply_url when there is no posting id. Never skip this because a posting id is missing. The returned apply_url is enough to start the browser worker immediately; do not wait for package_pending. Tell the user the outcome in plain language; never paste this object.",
          inputSchema: applicationTargetSchema,
          execute: (input) =>
            startPresentedApplication(scope, input, loadPresentedRoles()),
        }),
        find_next_goforay_roles: defineTool({
          description:
            "Immediately after starting an application, fetch up to five new curated JuiceBox roles for the same candidate. The started and previously shown roles are excluded. Never use this as an Exa fallback and never claim there are roles when the returned list is empty.",
          inputSchema: z.object({}),
          execute: async () => {
            const feed = await nextGoforayRoles(scope);
            storePresentedRoles(feed.cards);
            return feed;
          },
        }),
        get_goforay_application_task: defineTool({
          description:
            "Read the current GoForay application task, including any prepared documents and form answers. Optional extra context only. Never poll this as a start gate; the browser worker should already be running against apply_url. Do not dump documents, form_answers, or this object to the user.",
          inputSchema: z.object({ task_id: taskId }),
          execute: ({ task_id }) => applicationTask(scope, task_id),
        }),
        report_goforay_application_result: defineTool({
          description:
            "Record the outcome of the current GoForay browser task. Use submitted only after the ATS confirms submission; use needs_human for a field or challenge that requires the candidate; use failed for a terminal error. Tell the user the outcome in plain language; never paste this object.",
          inputSchema: z.object({
            task_id: taskId,
            status: z.enum(["submitted", "needs_human", "failed"]),
            error: z.string().max(2_000).optional(),
            external_id: z.string().max(500).optional(),
            confirmation_ref: z.string().max(500).optional(),
          }),
          execute: ({ task_id, ...result }) =>
            reportApplicationTask(scope, task_id, result),
        }),
      };
    },
  },
});
