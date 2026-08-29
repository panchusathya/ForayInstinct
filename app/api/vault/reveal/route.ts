import { z } from "zod";
import {
  requireRequestScope,
  UnauthenticatedError,
  unauthorizedResponse,
} from "@/app/_lib/server/request-scope";
import { isSameOrigin } from "@/app/_lib/server/same-origin";
import { readVaultItem } from "@/db/services/vault";
import { readSecret } from "@/lib/manager/server/secret-store";
import { parseLoginVaultPayload } from "@/lib/manager/vault-payload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requestSchema = z.object({
  id: z.string().trim().min(1).max(200),
});

export async function POST(request: Request) {
  try {
    const scope = await requireRequestScope();
    if (!isSameOrigin(request)) {
      return Response.json(
        { error: "Cross-origin vault reads are blocked." },
        { status: 403 }
      );
    }
    const { id } = requestSchema.parse(await request.json());
    const item = await readVaultItem(scope, id);
    if (item?.kind !== "login") {
      return Response.json(
        { error: "That login was not found." },
        { status: 404 }
      );
    }
    const secret = await readSecret({ id, namespace: "vault", scope });
    const login = secret ? parseLoginVaultPayload(secret) : undefined;
    if (login?.authentication.type !== "password") {
      return Response.json(
        { error: "This login has no stored password." },
        { status: 404 }
      );
    }
    return Response.json(
      {
        identifier: login.identifier.value,
        origin: "origin" in login ? login.origin : undefined,
        password: login.authentication.password,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthorizedResponse();
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Vault reveal failed.",
      },
      { status: 400 }
    );
  }
}
