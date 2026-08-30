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
}

function filenameMimeType(filename: string) {
  if (filename.toLowerCase().endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/pdf";
}
