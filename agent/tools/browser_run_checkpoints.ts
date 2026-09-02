import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { groupBrowserRunCheckpoints } from "@/lib/browser-submission";
import { listBrowserRunCheckpointsForExecution } from "@/db/services/browser-run-checkpoints";
import { listApplicationExecutionTraces } from "@/db/services/application-executions";
import { safeApplyUrl } from "@/lib/application-execution";
import { scopeFromPrincipal } from "@/lib/access-scope";

const identitySchema = z.object({
  apply_url: z.string().optional(),
  execution_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const missingIdentity =
  "Pass apply_url from the assignment header, or execution_id from a previous trace. Workspace-wide lookup is not supported.";

function identityQuery(input: z.infer<typeof identitySchema>) {
  const applyUrl = input.apply_url ? safeApplyUrl(input.apply_url) : "";
  const executionId = input.execution_id?.trim() ?? "";
  return {
    applyUrl: applyUrl === "" ? undefined : applyUrl,
    executionId: executionId === "" ? undefined : executionId,
    limit: input.limit,
  };
}

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
            "Read browser-run checkpoints for one application, grouped by browser session. Required: apply_url from the assignment header and/or execution_id. Call this when a worker returns an empty, missing, or malformed result. Each session lists its pages, phases, states, and times. A `submission_observed` state means the ATS confirmed the application even if the worker did not report it. An `awaiting_approval` state means the application is filled and paused for the candidate to review before submitting, so nothing has been sent yet.",
          inputSchema: identitySchema,
          async execute(input) {
            const query = identityQuery(input);
            if (!query.applyUrl && !query.executionId) {
              return { error: missingIdentity, sessions: [] };
            }
            const checkpoints = await listBrowserRunCheckpointsForExecution(
              scope,
              query
            );
            return { sessions: groupBrowserRunCheckpoints(checkpoints) };
          },
        }),
        list_application_execution_traces: defineTool({
          description:
            "Read the safe lifecycle trace for one application's workers, including role/company labels, normalized posting URLs, worker/browser session ids, model, timestamps, and terminal status. Required: apply_url from the assignment header and/or execution_id. Use this before claiming an application is stalled, restarted, or submitted. It never contains profile, form, screenshot, prompt, or reasoning data.",
          inputSchema: identitySchema,
          async execute(input) {
            const query = identityQuery(input);
            if (!query.applyUrl && !query.executionId) {
              return { error: missingIdentity, executions: [] };
            }
            return {
              executions: await listApplicationExecutionTraces(scope, query),
            };
          },
        }),
      };
    },
  },
});
