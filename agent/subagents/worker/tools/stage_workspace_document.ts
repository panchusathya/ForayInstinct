import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { readCandidateDocument } from "@/db/services/candidate-documents";
import { browserProvider } from "@/lib/browser";

const inputSchema = z.object({
  document_id: z.string().min(1).max(80),
  session_id: z.string().min(1),
});

const outputSchema = z.object({
  filename: z.string().min(1),
  path: z.string().startsWith("/tmp/workspace-"),
});

/** Stages one workspace-owned candidate document for an ATS file input. */
export default defineTool({
  description:
    "Stage one candidate document stored in this workspace into the owned browser filesystem. Use it for a cover letter or a non-default resume when the coordinator supplied the document id. Never pass a chat attachment path.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);
    const document = await readCandidateDocument(scope, input.document_id);
    if (document === undefined) {
      throw new Error("That document is not on file in this workspace.");
    }
    const filename = safeFilename(document.filename);
    const path = `/tmp/workspace-${input.document_id}-${filename}`;
    await browserProvider.stageFile(input.session_id, {
      bytes: document.bytes,
      path,
    });
    return { filename, path };
  },
});

function safeFilename(value: string) {
  const normalized = value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(-180);
  return normalized || "document.pdf";
}
