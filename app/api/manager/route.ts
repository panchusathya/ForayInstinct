import { managerMutationSchema } from "@/lib/manager";
import { isSameOrigin } from "@/app/_lib/server/same-origin";
import {
  requireRequestScope,
  UnauthenticatedError,
  unauthorizedResponse,
} from "@/app/_lib/server/request-scope";
import {
  applyManagerMutation,
  readManagerSnapshot,
} from "@/lib/manager/server/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const scope = await requireRequestScope();
    return Response.json(await readManagerSnapshot(scope), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthorizedResponse();
    return managerError(
      error instanceof Error ? error.message : "Manager request failed."
    );
  }
}

export async function POST(request: Request) {
  try {
    // Origin first: resolving the scope runs legacy-workspace adoption, which
    // a cross-site request must not be able to trigger.
    const denied = denyCrossOriginMutation(request);
    if (denied) return denied;
    const scope = await requireRequestScope();
    const mutation = managerMutationSchema.parse(await request.json());
    return Response.json(await applyManagerMutation(scope, mutation), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthorizedResponse();
    return managerError(
      error instanceof Error ? error.message : "Manager request failed."
    );
  }
}

function denyCrossOriginMutation(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json(
      { error: "Cross-origin manager writes are blocked." },
      { status: 403 }
    );
  }
}

function managerError(message: string) {
  return Response.json({ error: message }, { status: 400 });
}
