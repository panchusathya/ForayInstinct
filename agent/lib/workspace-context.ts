import type { AccessScope } from "@/lib/access-scope";
import {
  formatDocumentBytes,
  type CandidateDocumentMeta,
} from "@/lib/candidate-documents";
import { candidateProfileSummary } from "@/lib/candidate-profile";
import { listCandidateDocuments } from "@/db/services/candidate-documents";
import {
  readCandidateContactIdentity,
  readCandidateProfile,
} from "@/db/services/candidate-profile";
import { readSelfIdentification } from "@/db/services/self-identification";
import { listVaultItems } from "@/db/services/vault";
import { listWorkspaceMemories } from "@/db/services/workspace-memories";
import { prefetchGoogleWorkspaceContext } from "@/lib/google-workspace/prefetch";
import { declinedSelfIdentificationFields } from "@/lib/self-identification";

const resumeTextBudget = 4_000;

export async function buildWorkspaceContextRecall(scope: AccessScope) {
  const [
    profile,
    identity,
    documents,
    memories,
    vaultItems,
    selfIdentification,
    google,
  ] = await Promise.all([
    readCandidateProfile(scope),
    readCandidateContactIdentity(scope),
    listCandidateDocuments(scope),
    listWorkspaceMemories(scope),
    listVaultItems(scope),
    readSelfIdentification(scope),
    prefetchGoogleWorkspaceContext(scope),
  ]);

  const messages: { content: string; id: string }[] = [];
  const assignment = candidateProfileSummary(profile, identity);
  messages.push({
    content: [
      "Durable candidate profile for this workspace. Reuse these facts. Do not ask again for a field that already has a value.",
      assignment.text || "(profile is empty)",
    ].join("\n"),
    id: "candidate-profile",
  });

  messages.push({
    content: formatDocuments(documents),
    id: "owned-documents",
  });

  const defaultResume = documents.find(
    (document) => document.kind === "resume" && document.isDefault
  );
  if (defaultResume?.extractedText) {
    messages.push({
      content: [
        `Extracted text from the default resume (${defaultResume.filename}). Use it to fill application forms. Never expose the full text unless the candidate asked.`,
        defaultResume.extractedText.slice(0, resumeTextBudget),
      ].join("\n\n"),
      id: "default-resume-text",
    });
  }

  if (memories.length > 0) {
    messages.push({
      content: [
        "Facts remembered across conversations. Do not re-ask these.",
        ...memories.map((entry) => `• ${entry.key}: ${entry.value}`),
      ].join("\n"),
      id: "workspace-facts",
    });
  }

  const declined = declinedSelfIdentificationFields(selfIdentification);
  messages.push({
    content: [
      "Voluntary self-identification answers already on file. Unanswered fields are declined on forms; do not ask unless a form requires one with no decline option.",
      `Answered: ${
        [
          selfIdentification.gender
            ? `gender=${selfIdentification.gender}`
            : "",
          selfIdentification.raceEthnicity
            ? `race/ethnicity=${selfIdentification.raceEthnicity}`
            : "",
          selfIdentification.veteranStatus
            ? `veteran=${selfIdentification.veteranStatus}`
            : "",
          selfIdentification.disabilityStatus
            ? `disability=${selfIdentification.disabilityStatus}`
            : "",
        ]
          .filter(Boolean)
          .join("; ") || "(none)"
      }`,
      declined.length > 0
        ? `Declined unless required: ${declined.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    id: "self-identification",
  });

  if (vaultItems.length > 0) {
    messages.push({
      content: [
        "Vault items on file (labels only; secrets stay in the vault).",
        ...vaultItems.map(
          (item) =>
            `• ${item.kind} ${item.label}${item.account ? ` (${item.account})` : ""}`
        ),
      ].join("\n"),
      id: "vault-items",
    });
  }

  messages.push({
    content: formatGoogle(google),
    id: "google-connection",
  });

  return messages;
}

function formatDocuments(documents: readonly CandidateDocumentMeta[]) {
  if (documents.length === 0) {
    return [
      "No candidate documents are stored in this workspace yet.",
      "If the candidate attaches a PDF or DOCX it is saved here automatically.",
      "If Google is connected, search Gmail for a resume and call save_email_attachment instead of asking them to re-upload.",
    ].join(" ");
  }
  return [
    "Candidate documents stored in this workspace. Stage the default resume with stage_default_goforay_resume, or stage_workspace_document with an id. Never ask for a file that is already listed.",
    ...documents.map((document) => {
      const flags = [
        document.kind,
        document.isDefault ? "default" : "",
        formatDocumentBytes(document.byteSize),
        document.source,
        document.extractedText ? "text extracted" : "no extracted text",
      ].filter(Boolean);
      return `• ${document.filename} [${document.id}] (${flags.join(", ")})`;
    }),
  ].join("\n");
}

function formatGoogle(
  google: Awaited<ReturnType<typeof prefetchGoogleWorkspaceContext>>
) {
  if (google.state !== "connected") {
    return `Google Workspace is ${google.state}. Connect it from the workspace page to search Gmail and calendar.`;
  }
  const header = `Google Workspace is connected${
    google.accountLabel ? ` as ${google.accountLabel}` : ""
  }. Search Gmail or save an attachment with google_workspace_read; do not ask the candidate to paste mail that you can read.`;
  if (google.events.length === 0 || !google.localDate) {
    return `${header} No events on the calendar for today.`;
  }
  return [
    header,
    `Today on the calendar (${google.localDate}, ${google.timeZone}):`,
    ...google.events.map((event) => {
      const when = [event.start, event.end].filter(Boolean).join(" – ");
      return `• ${event.summary}${when ? ` (${when})` : ""}${
        event.location ? ` @ ${event.location}` : ""
      }`;
    }),
  ].join("\n");
}
