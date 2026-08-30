import { z } from "zod";
import { listRecentBrowserRunCheckpoints } from "@/db/services/browser-run-checkpoints";
import {
  requireRequestScope,
  UnauthenticatedError,
  unauthorizedResponse,
} from "@/app/_lib/server/request-scope";

export const runtime = "nodejs";

const responseSchema = z.object({
  checkpoints: z.array(
    z.object({
      action: z.string().nullable(),
      actions: z.array(z.string()),
      attempt: z.number().int(),
      createdAt: z.string(),
      errorCode: z.string().nullable(),
      page: z.string().nullable(),
      phase: z.string(),
      sessionId: z.string(),
      state: z.string().nullable(),
      trace: z.array(z.string()),
    })
  ),
});

export async function GET() {
  try {
    const scope = await requireRequestScope();
    return Response.json(
      responseSchema.parse({
        checkpoints: await listRecentBrowserRunCheckpoints(scope, 100),
      }),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthorizedResponse();
    console.error("Unable to read browser run checkpoints", error);
    return Response.json(
      { error: "Unable to read browser-run checkpoints." },
      { status: 500 }
    );
  }
}
