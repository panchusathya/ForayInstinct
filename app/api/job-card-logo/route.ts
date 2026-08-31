import { fetchEmployerLogo, sanitizeHostname } from "@/lib/goforay/card-logo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const domain = new URL(request.url).searchParams.get("domain") ?? "";
  if (!sanitizeHostname(domain)) {
    return new Response(null, { status: 404 });
  }
  const logo = await fetchEmployerLogo(`https://${sanitizeHostname(domain)}`);
  if (!logo) return new Response(null, { status: 404 });
  return new Response(logo.bytes, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": logo.contentType,
    },
  });
}
