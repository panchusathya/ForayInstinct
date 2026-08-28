import {
  requireRequestScope,
  UnauthenticatedError,
  unauthorizedResponse,
} from "@/app/_lib/server/request-scope";
import { applicationTaskDocument } from "@/lib/goforay/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Candidate-authenticated, short-lived proxy to one JuiceBox package document. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string; documentId: string }> }
) {
  try {
    const scope = await requireRequestScope();
    const { taskId, documentId } = await context.params;
    const document = await applicationTaskDocument(scope, taskId, documentId);
    return new Response(document.bytes, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": document.disposition || "attachment",
        "Content-Type": document.contentType,
      },
    });
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthorizedResponse();
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to read the document.",
      },
      { status: 400 }
    );
  }
}
