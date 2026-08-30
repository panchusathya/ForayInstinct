"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import {
  candidateDocumentListSchema,
  candidateDocumentMetaSchema,
  type CandidateDocumentKind,
  type CandidateDocumentMeta,
} from "@/lib/candidate-documents";

const apiErrorSchema = z.object({ error: z.string() });
const errorSchema = z.instanceof(Error);

export function useCandidateDocuments() {
  const [documents, setDocuments] = useState<CandidateDocumentMeta[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/documents", { cache: "no-store" });
    const body = z.unknown().parse(await response.json());
    if (!response.ok) {
      throw new Error(
        apiErrorSchema.safeParse(body).data?.error ??
          "Unable to list documents."
      );
    }
    return candidateDocumentListSchema.parse(body).documents;
  }, []);

  useEffect(() => {
    let active = true;
    async function loadDocuments() {
      try {
        const next = await load();
        if (active) setDocuments(next);
      } catch (loadError: unknown) {
        if (active) {
          setError(
            errorSchema.safeParse(loadError).data?.message ??
              "Unable to list documents."
          );
        }
      }
    }
    void loadDocuments();
    return () => {
      active = false;
    };
  }, [load]);

  const refresh = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setDocuments(await load());
      return true;
    } catch (actionError) {
      setError(
        errorSchema.safeParse(actionError).data?.message ??
          "Unable to update documents."
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File, kind: CandidateDocumentKind) => {
    return refresh(async () => {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", kind);
      form.set("setDefault", kind === "resume" ? "true" : "false");
      const response = await fetch("/api/documents", {
        body: form,
        method: "POST",
      });
      const body = z.unknown().parse(await response.json());
      if (!response.ok) {
        throw new Error(
          apiErrorSchema.safeParse(body).data?.error ??
            "Unable to save the file."
        );
      }
      candidateDocumentMetaSchema.parse(body);
    });
  };

  const setDefault = async (id: string) => {
    return refresh(async () => {
      const response = await fetch(`/api/documents/${id}`, {
        body: JSON.stringify({ action: "set_default" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const body = z.unknown().parse(await response.json());
        throw new Error(
          apiErrorSchema.safeParse(body).data?.error ??
            "Unable to set the default resume."
        );
      }
    });
  };

  const remove = async (id: string) => {
    return refresh(async () => {
      const response = await fetch(`/api/documents/${id}`, {
        body: JSON.stringify({ action: "delete" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const body = z.unknown().parse(await response.json());
        throw new Error(
          apiErrorSchema.safeParse(body).data?.error ??
            "Unable to delete the file."
        );
      }
    });
  };

  return { busy, documents, error, remove, setDefault, upload };
}
