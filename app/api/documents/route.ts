import {
  requireRequestScope,
  UnauthenticatedError,
  unauthorizedResponse,
} from "@/app/_lib/server/request-scope";
import { isSameOrigin } from "@/app/_lib/server/same-origin";
import {
  listCandidateDocuments,
  saveCandidateDocument,
} from "@/db/services/candidate-documents";
import { ensureScope } from "@/db/services/scope";
import {
  candidateDocumentKindSchema,
  candidateDocumentListSchema,
  candidateDocumentMetaSchema,
  isCandidateDocumentFile,
} from "@/lib/candidate-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const scope = await requireRequestScope();
    await ensureScope(scope);
    return Response.json(
      candidateDocumentListSchema.parse({
        documents: await listCandidateDocuments(scope),
      }),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthorizedResponse();
    return documentError(
      error instanceof Error ? error.message : "Unable to list documents."
    );
  }
}

export async function POST(request: Request) {
  try {
    if (!isSameOrigin(request)) {
      return Response.json(
        { error: "Invalid request origin." },
        { status: 403 }
      );
    }
    const scope = await requireRequestScope();
    await ensureScope(scope);
    const form = await request.formData();
    const value = form.get("file");
    if (!(value instanceof File)) {
      return Response.json({ error: "Choose a file first." }, { status: 400 });
    }
    const filename = value.name || "document";
    if (!isCandidateDocumentFile(filename, value.type)) {
      return Response.json(
        { error: "Upload a PDF, Word (.docx), or text file." },
        { status: 415 }
      );
    }
    const rawKind = form.get("kind");
    const parsedKind =
      typeof rawKind === "string" && rawKind.length > 0
        ? candidateDocumentKindSchema.safeParse(rawKind)
        : undefined;
    const kind = parsedKind?.success === true ? parsedKind.data : undefined;
    const saved = await saveCandidateDocument(scope, {
      bytes: Buffer.from(await value.arrayBuffer()),
      filename,
      ...(kind ? { kind } : {}),
      mimeType: value.type,
      setDefault: form.get("setDefault") === "true",
      source: "upload",
    });
    return Response.json(candidateDocumentMetaSchema.parse(saved.document), {
      status: saved.created ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthorizedResponse();
    return documentError(
      error instanceof Error ? error.message : "Unable to save the file."
    );
  }
}

function documentError(message: string) {
  return Response.json({ error: message }, { status: 400 });
}
