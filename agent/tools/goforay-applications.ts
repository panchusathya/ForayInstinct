import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { scopeFromPrincipal } from "@/lib/access-scope";
import {
  applicationTask,
  createApplicationTask,
  findGoforayRoles,
  nextGoforayRoles,
  reportApplicationTask,
} from "@/lib/goforay/bridge";

/**
 * Coordinator tools for a candidate application fill.
 *
 * Typical call order after "apply to this role":
 * 1. `start_goforay_application` → JuiceBox POST /application-tasks
 * 2. `worker` immediately, with apply_url (+ task/document IDs if present)
 * 3. Worker: manage_browsers.create → stage resume → Playwright/computer fill
 * 4. `report_goforay_application_result` → JuiceBox POST /application-tasks/:id/result
 *
 * `get_goforay_application_task` is optional extra context, not a start gate.
 */

const taskId = z.string().min(1).max(80);

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
            "Immediately find roles whenever the user asks to find roles, show openings, or suggest jobs. This first returns actionable JuiceBox matches. If none exist or the candidate is new, it searches Exa for live public openings and returns those in the same conversation. Never promise a future delivery. Only JuiceBox cards contain a posting_id and can be started through the GoForay application task. Present cards to the user as short bullets (title, company, location, link); never paste this object.",
          inputSchema: z.object({
            query: z.string().max(120).optional(),
            location: z.string().max(120).optional(),
            limit: z.number().int().min(1).max(10).default(5),
          }),
          execute: ({ query, location, limit }) =>
            findGoforayRoles(scope, { query, location, limit }),
        }),
        start_goforay_application: defineTool({
          description:
            "Start exactly one GoForay application task for the concrete JuiceBox job posting ID the candidate asked to apply to. This task is the candidate's authority for that role. It never accepts credentials and does not submit any other role. The returned apply_url is enough to start the browser worker immediately; do not wait for package_pending. Tell the user the outcome in plain language; never paste this object.",
          inputSchema: z.object({
            job_posting_id: z.uuid(),
          }),
          execute: ({ job_posting_id }) =>
            createApplicationTask(scope, job_posting_id),
        }),
        find_next_goforay_roles: defineTool({
          description:
            "Immediately after starting an application, fetch up to five new curated JuiceBox roles for the same candidate. The started and previously shown roles are excluded. Never use this as an Exa fallback and never claim there are roles when the returned list is empty.",
          inputSchema: z.object({}),
          execute: () => nextGoforayRoles(scope),
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
