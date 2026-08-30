import { z } from "zod";
import {
  requireRequestScope,
  UnauthenticatedError,
  unauthorizedResponse,
} from "@/app/_lib/server/request-scope";
import { isSameOrigin } from "@/app/_lib/server/same-origin";
import {
  deleteCandidateDocument,
  readCandidateDocument,
  setDefaultCandidateDocument,
} from "@/db/services/candidate-documents";
import { candidateDocumentMetaSchema } from "@/lib/candidate-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_default") }),
  z.object({ action: z.literal("delete") }),
]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireRequestScope();
    const { id } = await context.params;
    const document = await readCandidateDocument(scope, id);
    if (document === undefined) {
      return Response.json(
        { error: "That document is not on file." },
        { status: 404 }
      );
    }
    return new Response(new Uint8Array(document.bytes), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${document.filename.replaceAll('"', "")}"`,
        "Content-Type": document.mimeType,
      },
    });
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthorizedResponse();
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to download the file.",
      },
      { status: 400 }
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    if (!isSameOrigin(request)) {
      return Response.json(
        { error: "Cross-origin document writes are blocked." },
        { status: 403 }
      );
    }
    const scope = await requireRequestScope();
    const { id } = await context.params;
    const mutation = mutationSchema.parse(await request.json());
    if (mutation.action === "delete") {
      await deleteCandidateDocument(scope, id);
      return Response.json(
        { deleted: true },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    const document = await setDefaultCandidateDocument(scope, id);
    if (document === undefined) {
      return Response.json(
        { error: "That document is not on file." },
        { status: 404 }
      );
    }
    return Response.json(candidateDocumentMetaSchema.parse(document), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthorizedResponse();
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to update the document.",
      },
      { status: 400 }
    );
  }
}
