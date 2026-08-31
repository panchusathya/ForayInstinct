import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { recordSubmissionReviewEvidence } from "@/agent/subagents/worker/lib/browser-run-evidence";
import { handleBrowserToolFailure } from "@/agent/subagents/worker/lib/challenge-diagnostics";

const inputSchema = z.object({
  apply_url: z.string().min(1),
  role: z.string().min(1),
  session_id: z.string().min(1),
});

const outputSchema = z.object({
  captured: z.number(),
  next_action: z.string(),
  status: z.literal("awaiting_approval"),
});

export default defineTool({
  description:
    "Capture the completed application for the candidate to check before the final submit control is activated. Call this once the whole application is filled and the only remaining step is submitting it, and never after submitting. Screenshots of the review page are captured with vault fields masked, stored, and delivered to the candidate by the channel; the tool never touches the submit control. Finish the turn afterwards with final_output `failure` and a message beginning `Needs submission approval:`, then submit only after the coordinator resumes you with the candidate's approval. Does not create or delete browsers.",
  inputSchema,
  outputSchema: z.toJSONSchema(outputSchema),
  async execute(input, context): Promise<z.infer<typeof outputSchema>> {
    const scope = await requireWorkerScope(context);
    try {
      await requireOwnedBrowserSession(scope, input.session_id);
      const captured = await recordSubmissionReviewEvidence(
        scope,
        input.session_id,
        { applyUrl: input.apply_url, role: input.role },
        context.abortSignal
      );
      return {
        captured,
        next_action:
          captured > 0
            ? "Call final_output with `failure` and a message beginning `Needs submission approval:` naming the role, the apply URL, and what will be submitted. Do not activate the submit control until the coordinator resumes you with the candidate's approval."
            : "No screenshot could be captured. Still call final_output with `failure` and a message beginning `Needs submission approval:`, and include the browser live-view URL so the candidate can check the form directly. Do not submit unreviewed.",
        status: "awaiting_approval",
      };
    } catch (error: unknown) {
      throw await handleBrowserToolFailure({
        error,
        scope,
        sessionId: input.session_id,
        signal: context.abortSignal,
        tool: "request_submission_approval",
        trigger: "request_submission_approval",
      });
    }
  },
});
