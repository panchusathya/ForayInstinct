import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { readOrImportDefaultResume } from "@/db/services/default-resume";
import { kernel } from "@/lib/kernel";

const inputSchema = z.object({
  session_id: z.string().min(1),
});

const outputSchema = z.object({
  filename: z.string().min(1),
  path: z.string().startsWith("/tmp/goforay-"),
});

/** Stages the workspace-owned default resume for a direct external ATS. */
export default defineTool({
  description:
    "Stage the candidate's default resume stored in this workspace into the owned browser filesystem. Use this instead of any chat attachment path or URL. The file is workspace-owned; do not wait on JuiceBox.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);
    let document;
    try {
      document = await readOrImportDefaultResume(scope);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/still being parsed|still processing/iu.test(message)) {
        throw new Error(
          "The resume is safely stored but still being parsed by GoForay. Keep the browser open and retry staging it shortly; do not ask for another upload.",
          { cause: error }
        );
      }
      if (/No protected default resume|not linked/iu.test(message)) {
        throw new Error(
          "No resume is on file in this workspace. Ask the candidate to attach a PDF or DOCX, or save one from Gmail.",
          { cause: error }
        );
      }
      throw new Error(
        `The stored resume could not be retrieved right now: ${message || "unknown bridge error"}. Preserve the browser and report this blocker; do not ask for another upload.`,
        { cause: error }
      );
    }
    const filename = safeFilename(document.filename);
    const path = `/tmp/goforay-default-resume-${filename}`;
    await kernel.browsers.fs.writeFile(input.session_id, document.bytes, {
      path,
    });
    return { filename, path };
  },
});

function safeFilename(value: string) {
  const normalized = value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(-180);
  return normalized || "resume.pdf";
}
