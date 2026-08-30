import type { AccessScope } from "@/lib/access-scope";
import { candidateDefaultResume } from "@/lib/goforay/bridge";
import {
  readDefaultResume,
  saveCandidateDocument,
} from "./candidate-documents";

/**
 * Workspace-owned default resume bytes. If the candidate never uploaded here
 * but still has a JuiceBox default, import it once so later fills stay local.
 */
export async function readOrImportDefaultResume(scope: AccessScope) {
  const stored = await readDefaultResume(scope);
  if (stored) return stored;

  try {
    const remote = await candidateDefaultResume(scope);
    const imported = await saveCandidateDocument(scope, {
      bytes: Buffer.from(remote.bytes),
      filename: remote.filename,
      kind: "resume",
      mimeType: filenameMimeType(remote.filename),
      setDefault: true,
      source: "goforay",
    });
    return imported.document;
  } catch (error: unknown) {
    if (isExpectedMissingRemoteResume(error)) return;
    console.error("[default-resume] JuiceBox import failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    throw error;
  }
}

function isExpectedMissingRemoteResume(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return (
    message === "GoForay integration is not configured." ||
    message.startsWith("Link your GoForay account") ||
    message.startsWith("The protected default resume is unavailable")
  );
}

function filenameMimeType(filename: string) {
  if (filename.toLowerCase().endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/pdf";
}
