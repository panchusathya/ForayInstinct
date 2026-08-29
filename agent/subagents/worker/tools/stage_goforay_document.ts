import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { applicationTaskDocument } from "@/lib/goforay/bridge";
import { withWorkerToolError } from "@/agent/lib/worker-tool-error";
import { writeBrowserFile } from "@/lib/browser";

const inputSchema = z.object({
  document_id: z.string().min(1).max(80),
  session_id: z.string().min(1),
  task_id: z.string().min(1).max(80),
});

const outputSchema = z.object({
  filename: z.string().min(1),
  path: z.string().startsWith("/tmp/goforay-"),
});

/**
 * Moves one prepared JuiceBox document directly into the owned browser session.
 * The model receives a file path only; it never sees the resume bytes or a
 * bearer credential that could be replayed outside this task.
 */
export default defineTool({
  description:
    "Stage one prepared GoForay application document in the owned browser filesystem before attaching it to an ATS file input. Call it only for the task and document IDs the coordinator supplied.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    return withWorkerToolError(
      "stage_goforay_document",
      input.session_id,
      async () => {
        await requireOwnedBrowserSession(scope, input.session_id);
        const document = await applicationTaskDocument(
          scope,
          input.task_id,
          input.document_id
        );
        const filename = safeFilename(
          document.filename || `${input.document_id}.pdf`
        );
        const path = `/tmp/goforay-${input.document_id}-${filename}`;
        await writeBrowserFile(
          input.session_id,
          path,
          new Uint8Array(document.bytes)
        );
        return { filename, path };
      }
    );
  },
});

function safeFilename(value: string) {
  const normalized = value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(-180);
  return normalized || "document.pdf";
}
