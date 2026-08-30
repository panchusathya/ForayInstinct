import type { AccessScope } from "@/lib/access-scope";
import { ensureScope } from "@/db/services/scope";
import {
  readWorkspaceKernelProfileId,
  saveWorkspaceKernelProfileId,
} from "@/db/services/workspaces";
import { kernel } from "@/lib/kernel";

export function kernelProfileName(workspaceId: string) {
  const suffix = workspaceId.includes(":")
    ? workspaceId.slice(workspaceId.indexOf(":") + 1)
    : workspaceId;
  const safe = suffix.replaceAll(/[^a-zA-Z0-9._-]/g, "").slice(0, 200);
  return `foray-${safe || "workspace"}`;
}

/**
 * Resolve or create the workspace Kernel browser profile. Fail open: a Kernel
 * outage must not block creating a browser.
 */
export async function ensureKernelBrowserProfile(
  scope: AccessScope,
  signal?: AbortSignal
): Promise<string | undefined> {
  await ensureScope(scope);
  const stored = await readWorkspaceKernelProfileId(scope);
  if (stored) return stored;

  const name = kernelProfileName(scope.workspaceId);
  try {
    let profile: { id: string };
    try {
      profile = await kernel.profiles.create({ name }, { signal });
    } catch (error) {
      console.error("[kernel-profile] create failed, trying retrieve", {
        error: error instanceof Error ? error.message : String(error),
        workspaceId: scope.workspaceId,
      });
      profile = await kernel.profiles.retrieve(name, { signal });
    }
    await saveWorkspaceKernelProfileId(scope, profile.id);
    return profile.id;
  } catch (error) {
    console.error("[kernel-profile] unavailable", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: scope.workspaceId,
    });
    return undefined;
  }
}

/** Kill switch: delete the Kernel profile then clear the stored id. */
export async function deleteKernelBrowserProfile(scope: AccessScope) {
  await ensureScope(scope);
  const stored = await readWorkspaceKernelProfileId(scope);
  if (!stored) return;
  try {
    await kernel.profiles.delete(stored);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const cleared = await saveWorkspaceKernelProfileId(scope, "");
  if (!cleared.stored) {
    throw new Error(
      "The browser profile was deleted but could not be cleared locally."
    );
  }
}

function isNotFound(error: unknown) {
  if (typeof error === "object" && error !== null && "status" in error) {
    return error.status === 404;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b|not found/i.test(message);
}
