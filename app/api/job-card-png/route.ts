import { z } from "zod";
import { renderJobCardPng } from "@/lib/goforay/card-png";
import { isJobCardSecret } from "@/lib/goforay/job-card-secret";
import { goForayJobCardSchema } from "@/lib/goforay/job-cards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  card: goForayJobCardSchema,
  index: z.number().int().positive(),
  total: z.number().int().positive(),
});

export async function POST(request: Request) {
  if (!isJobCardSecret(request.headers.get("x-job-card-secret"))) {
    return new Response(null, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response(null, { status: 400 });
  const png = await renderJobCardPng(
    parsed.data.card,
    parsed.data.index,
    parsed.data.total
  );
  if (!png) return new Response(null, { status: 500 });
  return new Response(png.bytes, {
    headers: {
      // The filename is built from the employer's name; a quote or a control
      // character in it must not reach the header.
      "Content-Disposition": `inline; filename="${safeHeaderFilename(png.filename)}"`,
      "Content-Type": "image/png",
    },
  });
}

/** Quotes, backslashes and control characters must not reach the header. */
function safeHeaderFilename(filename: string) {
  return filename.replaceAll(/["\\]/gu, "").replaceAll(/\p{Cc}/gu, "");
}
