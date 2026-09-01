import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { groupBrowserRunCheckpoints } from "@/lib/browser-submission";
import { listRecentBrowserRunCheckpoints } from "@/db/services/browser-run-checkpoints";
import { listApplicationExecutionTraces } from "@/db/services/application-executions";
import { scopeFromPrincipal } from "@/lib/access-scope";

/**
 * Durable trail of browser runs for the coordinator. A worker turn can finish
 * without `final_output`; this is how a submission still surfaces.
 */
export default defineDynamic({
  events: {
    "step.started": (_event, context) => {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      if (!caller) return null;
      const scope = scopeFromPrincipal(caller);

      return {
        list_browser_run_checkpoints: defineTool({
          description:
            "Read recent browser-run checkpoints for this workspace, grouped by browser session. Call this when a worker returns an empty, missing, or malformed result, or when more than one application is in flight. Each session lists its pages, phases, states, and times. A `submission_observed` state means the ATS confirmed the application even if the worker did not report it. An `awaiting_approval` state means the application is filled and paused for the candidate to review before submitting, so nothing has been sent yet.",
          inputSchema: z.object({
            limit: z.number().int().min(1).max(100).optional(),
          }),
          async execute({ limit }) {
            const checkpoints = await listRecentBrowserRunCheckpoints(
              scope,
              limit ?? 100
            );
            return { sessions: groupBrowserRunCheckpoints(checkpoints) };
          },
        }),
        list_application_execution_traces: defineTool({
          description:
            "Read the safe lifecycle trace for recent application workers, including role/company labels, normalized posting URLs, worker/browser session ids, model, timestamps, and terminal status. Use this before claiming an application is stalled, restarted, or submitted. It never contains profile, form, screenshot, prompt, or reasoning data.",
          inputSchema: z.object({
            limit: z.number().int().min(1).max(100).optional(),
          }),
          async execute({ limit }) {
            return {
              executions: await listApplicationExecutionTraces(
                scope,
                limit ?? 50
              ),
            };
          },
        }),
      };
    },
  },
});
