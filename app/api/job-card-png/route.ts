import { z } from "zod";
import { env } from "@/lib/env";
import { renderJobCardPng } from "@/lib/goforay/card-png";
import { goForayJobCardSchema } from "@/lib/goforay/job-cards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  card: goForayJobCardSchema,
  index: z.number().int().positive(),
  total: z.number().int().positive(),
});

export async function POST(request: Request) {
  if (request.headers.get("x-job-card-secret") !== env.BETTER_AUTH_SECRET) {
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
      "Content-Disposition": `inline; filename="${png.filename}"`,
      "Content-Type": "image/png",
    },
  });
}
