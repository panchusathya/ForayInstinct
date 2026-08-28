import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { scopeFromPrincipal } from "@/lib/access-scope";
import {
  applicationTask,
  createApplicationTask,
  findGoforayRoles,
  reportApplicationTask,
} from "@/lib/goforay/bridge";

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
            "Immediately find roles whenever the user asks to find roles, show openings, or suggest jobs. This first returns actionable JuiceBox matches. If none exist or the candidate is new, it searches Exa for live public openings and returns those in the same conversation. Never promise a future delivery. Only JuiceBox cards contain a posting_id and can be started through the GoForay application task.",
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
            "Start exactly one GoForay application task for the concrete JuiceBox job posting ID the candidate asked to apply to. This task is the candidate's authority for that role. It never accepts credentials and does not submit any other role.",
          inputSchema: z.object({
            job_posting_id: z.uuid(),
          }),
          execute: ({ job_posting_id }) =>
            createApplicationTask(scope, job_posting_id),
        }),
        get_goforay_application_task: defineTool({
          description:
            "Read the prepared-document and form-answer state for a previously requested GoForay application task.",
          inputSchema: z.object({ task_id: taskId }),
          execute: ({ task_id }) => applicationTask(scope, task_id),
        }),
        report_goforay_application_result: defineTool({
          description:
            "Record the outcome of the current GoForay browser task. Use submitted only after the ATS confirms submission; use needs_human for a field or challenge that requires the candidate; use failed for a terminal error.",
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
