import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { scopeFromPrincipal } from "@/lib/access-scope";
import {
  formatDocumentBytes,
  type CandidateDocumentMeta,
} from "@/lib/candidate-documents";
import {
  deleteCandidateDocument,
  listCandidateDocuments,
  setDefaultCandidateDocument,
} from "@/db/services/candidate-documents";

export default defineDynamic({
  events: {
    "step.started": (_event, context) => {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      if (!caller) return null;
      const scope = scopeFromPrincipal(caller);

      return {
        candidate_documents: defineTool({
          description:
            "List, choose the default, or delete candidate documents stored in this workspace (resumes, cover letters, transcripts). Uploads come from chat, the profile page, iMessage, or save_email_attachment. Use list before asking for a resume. Never ask for a file that is already listed.",
          inputSchema: z.object({
            action: z.enum(["list", "set_default", "delete"]),
            document_id: z.string().min(1).max(80).optional(),
          }),
          async execute({ action, document_id: documentId }) {
            if (action === "list") {
              const documents = await listCandidateDocuments(scope);
              return {
                documents: documents.map(summarizeDocument),
                missing: documents.some(
                  (document) => document.kind === "resume" && document.isDefault
                )
                  ? []
                  : ["default resume"],
              };
            }
            if (!documentId) {
              throw new Error("document_id is required for this action.");
            }
            if (action === "delete") {
              await deleteCandidateDocument(scope, documentId);
              return { deleted: documentId };
            }
            const document = await setDefaultCandidateDocument(
              scope,
              documentId
            );
            if (document === undefined) {
              throw new Error("That document is not on file.");
            }
            return { document: summarizeDocument(document) };
          },
        }),
      };
    },
  },
});

function summarizeDocument(document: CandidateDocumentMeta) {
  return {
    extracted: document.extractedText.length > 0,
    filename: document.filename,
    id: document.id,
    isDefault: document.isDefault,
    kind: document.kind,
    size: formatDocumentBytes(document.byteSize),
    source: document.source,
  };
}
