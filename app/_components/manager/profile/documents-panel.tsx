"use client";

import { useRef } from "react";
import { Trash2Icon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  formatDocumentBytes,
  inferCandidateDocumentKind,
  type CandidateDocumentMeta,
} from "@/lib/candidate-documents";
import { useCandidateDocuments } from "./use-candidate-documents";

export function CandidateDocumentsPanel() {
  const { busy, documents, error, remove, setDefault, upload } =
    useCandidateDocuments();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="type-caption text-muted-foreground uppercase">
          Documents
        </h2>
        <Button
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          size="sm"
          type="button"
          variant="ghost"
        >
          Upload
        </Button>
      </div>
      <p className="type-supporting-body text-muted-foreground">
        Resumes and other files stay in this workspace. Foray recalls them on
        every chat and attaches the default resume to applications.
      </p>
      <input
        accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
        className="sr-only"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void upload(file, inferCandidateDocumentKind(file.name));
        }}
        ref={inputRef}
        type="file"
      />
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Documents unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {documents.length === 0 ? (
        <p className="type-supporting-body text-muted-foreground">
          No files yet. Upload a PDF or Word resume, or send one in chat.
        </p>
      ) : (
        <ul className="space-y-2">
          {documents.map((document) => (
            <DocumentRow
              busy={busy}
              document={document}
              key={document.id}
              onDelete={() => void remove(document.id)}
              onSetDefault={() => void setDefault(document.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function DocumentRow({
  busy,
  document,
  onDelete,
  onSetDefault,
}: {
  readonly busy: boolean;
  readonly document: CandidateDocumentMeta;
  readonly onDelete: () => void;
  readonly onSetDefault: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
      <div className="min-w-0 space-y-1">
        <p className="type-body truncate">{document.filename}</p>
        <p className="type-supporting-body text-muted-foreground">
          {document.kind.replaceAll("_", " ")} ·{" "}
          {formatDocumentBytes(document.byteSize)} · {document.source}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {document.isDefault ? <Badge>Default resume</Badge> : null}
        {document.kind === "resume" && !document.isDefault ? (
          <Button
            disabled={busy}
            onClick={onSetDefault}
            size="sm"
            type="button"
            variant="outline"
          >
            Make default
          </Button>
        ) : null}
        <Button
          aria-label={`Delete ${document.filename}`}
          disabled={busy}
          onClick={onDelete}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Trash2Icon />
        </Button>
      </div>
    </li>
  );
}
