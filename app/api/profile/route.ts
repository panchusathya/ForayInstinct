import { z } from "zod";
import {
  requireRequestScope,
  UnauthenticatedError,
  unauthorizedResponse,
} from "@/app/_lib/server/request-scope";
import { isSameOrigin } from "@/app/_lib/server/same-origin";
import {
  readCandidateContactIdentity,
  readCandidateProfile,
  saveCandidateProfile,
} from "@/db/services/candidate-profile";
import { ensureScope } from "@/db/services/scope";
import { readWorkspaceKernelProfileId } from "@/db/services/workspaces";
import {
  candidateProfilePatchSchema,
  candidateProfileResponseSchema,
} from "@/lib/candidate-profile";
import { deleteKernelBrowserProfile } from "@/lib/manager/server/kernel-profile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    profile: candidateProfilePatchSchema,
  }),
  z.object({ action: z.literal("sign_out_everywhere") }),
]);

export async function GET() {
  try {
    const scope = await requireRequestScope();
    return Response.json(await readProfileSnapshot(scope), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthorizedResponse();
    return profileError(
      error instanceof Error ? error.message : "Profile request failed."
    );
  }
}

export async function POST(request: Request) {
  try {
    const scope = await requireRequestScope();
    if (!isSameOrigin(request)) {
      return Response.json(
        { error: "Cross-origin profile writes are blocked." },
        { status: 403 }
      );
    }
    const mutation = mutationSchema.parse(await request.json());
    if (mutation.action === "sign_out_everywhere") {
      await deleteKernelBrowserProfile(scope);
      return Response.json(await readProfileSnapshot(scope), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const saved = await saveCandidateProfile(scope, mutation.profile);
    if (!saved.stored) {
      return profileError("Could not save profile.");
    }
    return Response.json(await readProfileSnapshot(scope), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthorizedResponse();
    return profileError(
      error instanceof Error ? error.message : "Profile request failed."
    );
  }
}

async function readProfileSnapshot(scope: Awaited<ReturnType<typeof requireRequestScope>>) {
  await ensureScope(scope);
  const [profile, identity, kernelProfileId] = await Promise.all([
    readCandidateProfile(scope),
    readCandidateContactIdentity(scope),
    readWorkspaceKernelProfileId(scope),
  ]);
  return candidateProfileResponseSchema.parse({
    identity: seedIdentity(identity),
    kernelProfileId,
    profile: seedLegalName(profile, identity.name),
  });
}

function seedIdentity(identity: {
  readonly email?: string;
  readonly name: string;
  readonly phone?: string;
}) {
  return {
    name: identity.name,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.phone ? { phone: identity.phone } : {}),
  };
}

function seedLegalName(
  profile: Awaited<ReturnType<typeof readCandidateProfile>>,
  name: string
) {
  if (profile.legalFirstName || profile.legalLastName || !name.trim()) {
    return profile;
  }
  const [first = "", ...rest] = name.trim().split(/\s+/u);
  return {
    ...profile,
    legalFirstName: first,
    legalLastName: rest.join(" "),
  };
}

function profileError(message: string) {
  return Response.json({ error: message }, { status: 400 });
}
