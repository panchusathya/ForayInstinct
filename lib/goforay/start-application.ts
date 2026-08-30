import type { AccessScope } from "@/lib/access-scope";
import { createApplicationTask } from "./bridge";
import type { GoForayJobCard } from "./job-cards";
import {
  resolvePresentedRole,
  type ApplicationTargetInput,
} from "./presented-roles";

/**
 * Resolve one chosen role to an apply URL. JuiceBox posting ids still create
 * a CRM task; Exa leads and pasted links skip that and return the URL the
 * worker needs.
 */
export async function startPresentedApplication(
  scope: AccessScope,
  input: ApplicationTargetInput,
  presented: GoForayJobCard[]
) {
  const lead = resolvePresentedRole(input, presented);
  const postingId = input.job_posting_id ?? lead?.posting_id;
  const applyUrl = input.apply_url ?? lead?.url;

  if (postingId) {
    try {
      return await createApplicationTask(scope, postingId);
    } catch (error) {
      if (!applyUrl) throw error;
    }
  }

  if (!applyUrl) {
    return {
      apply_url: "",
      error:
        "No apply URL for that role. Call find_goforay_roles first, or pass apply_url.",
    };
  }

  return {
    apply_url: applyUrl,
    company: lead?.company ?? "",
    location: lead?.location ?? "",
    title: lead?.title ?? "Open role",
  };
}
