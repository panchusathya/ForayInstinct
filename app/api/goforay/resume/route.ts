import {
  requireRequestScope,
  UnauthenticatedError,
  unauthorizedResponse,
} from "@/app/_lib/server/request-scope";
import { isSameOrigin } from "@/app/_lib/server/same-origin";
import { uploadCandidateResume } from "@/lib/goforay/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const resumeTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

/** Candidate-authenticated upload proxy; JuiceBox validates the file bytes. */
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
    const filename = value.name.toLowerCase();
    if (!resumeTypes.has(value.type) && !/\.(pdf|docx)$/u.test(filename)) {
      return Response.json(
        { error: "Upload a PDF or Word (.docx) resume." },
        { status: 415 }
      );
    }
    return Response.json(await uploadCandidateResume(scope, value), {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
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
