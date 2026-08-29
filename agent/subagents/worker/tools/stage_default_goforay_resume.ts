import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { candidateDefaultResume } from "@/lib/goforay/bridge";
import { withWorkerToolError } from "@/agent/lib/worker-tool-error";
import { writeBrowserFile } from "@/lib/browser";

const inputSchema = z.object({
  session_id: z.string().min(1),
});

const outputSchema = z.object({
  filename: z.string().min(1),
  path: z.string().startsWith("/tmp/goforay-"),
});

/** Stages the candidate's protected default resume for a direct external ATS. */
export default defineTool({
  description:
    "Stage the linked candidate's parsed protected default resume in the owned browser filesystem for a direct external ATS upload. Use this instead of any chat attachment path or URL.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    return withWorkerToolError(
      "stage_default_goforay_resume",
      input.session_id,
      async () => {
        await requireOwnedBrowserSession(scope, input.session_id);
        const document = await candidateDefaultResume(scope);
        const filename = safeFilename(document.filename);
        const path = `/tmp/goforay-default-resume-${filename}`;
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
  return normalized || "resume.pdf";
}
