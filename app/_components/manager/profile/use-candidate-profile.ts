"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import {
  candidateProfileResponseSchema,
  type CandidateProfilePatch,
  type CandidateProfileResponse,
} from "@/lib/candidate-profile";

const apiErrorSchema = z.object({ error: z.string() });
const errorSchema = z.instanceof(Error);

export function useCandidateProfile() {
  const [snapshot, setSnapshot] = useState<CandidateProfileResponse>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/profile", { cache: "no-store" });
    const body = z.unknown().parse(await response.json());
    if (!response.ok) {
      throw new Error(
        apiErrorSchema.safeParse(body).data?.error ?? "Profile request failed."
      );
    }
    return candidateProfileResponseSchema.parse(body);
  }, []);

  useEffect(() => {
    let active = true;

    async function loadSnapshot() {
      try {
        const next = await load();
        if (active) setSnapshot(next);
      } catch (refreshError: unknown) {
        if (active) {
          setError(
            errorSchema.safeParse(refreshError).data?.message ??
              "Profile request failed."
          );
        }
      }
    }

    void loadSnapshot();
    return () => {
      active = false;
    };
  }, [load]);

  /**
   * Writes a patch and returns the fresh snapshot, or nothing when the save
   * was refused. `expectUpdatedAt` is the marker the page loaded; the server
   * answers 409 when the profile has moved on since, and that message is
   * surfaced like any other error.
   */
  const save = async (
    profile: CandidateProfilePatch,
    options: { readonly expectUpdatedAt?: string } = {}
  ) => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/profile", {
        body: JSON.stringify({
          action: "save",
          profile,
          ...(options.expectUpdatedAt === undefined
            ? {}
            : { expectUpdatedAt: options.expectUpdatedAt }),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = z.unknown().parse(await response.json());
      if (!response.ok) {
        throw new Error(
          apiErrorSchema.safeParse(body).data?.error ??
            "Could not save profile."
        );
      }
      const next = candidateProfileResponseSchema.parse(body);
      setSnapshot(next);
      return next;
    } catch (saveError) {
      setError(
        errorSchema.safeParse(saveError).data?.message ??
          "Could not save profile."
      );
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const signOutEverywhere = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/profile", {
        body: JSON.stringify({ action: "sign_out_everywhere" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = z.unknown().parse(await response.json());
      if (!response.ok) {
        throw new Error(
          apiErrorSchema.safeParse(body).data?.error ??
            "Could not sign out of saved browser sessions."
        );
      }
      setSnapshot(candidateProfileResponseSchema.parse(body));
      return true;
    } catch (signOutError) {
      setError(
        errorSchema.safeParse(signOutError).data?.message ??
          "Could not sign out of saved browser sessions."
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, save, signOutEverywhere, snapshot };
}
