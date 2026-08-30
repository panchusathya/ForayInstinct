import {
  requireRequestScope,
  UnauthenticatedError,
  unauthorizedResponse,
} from "@/app/_lib/server/request-scope";
import { isSameOrigin } from "@/app/_lib/server/same-origin";
import { saveCandidateDocument } from "@/db/services/candidate-documents";
import { inferCandidateDocumentKind } from "@/lib/candidate-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Candidate-authenticated upload; stored in this workspace, not JuiceBox. */
export async function POST(request: Request) {
  try {
    if (!isSameOrigin(request)) {
      return Response.json(
        { error: "Invalid request origin." },
        { status: 403 }
      );
    }
    const scope = await requireRequestScope();
    const form = await request.formData();
    const value = form.get("file");
    if (!(value instanceof File)) {
      return Response.json(
        { error: "Choose a resume file first." },
        { status: 400 }
      );
    }
    const filename = value.name || "resume.pdf";
    const saved = await saveCandidateDocument(scope, {
      bytes: Buffer.from(await value.arrayBuffer()),
      filename,
      kind: inferCandidateDocumentKind(filename),
      mimeType: value.type,
      setDefault: true,
      source: "upload",
    });
    return Response.json(
      { filename: saved.document.filename, id: saved.document.id },
      {
        status: saved.created ? 201 : 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthorizedResponse();
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to upload the resume.",
      },
      { status: 400 }
    );
  }
}
