import { NextResponse, type NextRequest } from "next/server";
import { getAuthSession } from "@/auth/session";

/** Cookie-free entrypoints. Each handler still enforces its own credential. */
export function isPublicPath(pathname: string) {
  return (
    pathname === "/sign-in" ||
    pathname.startsWith("/api/auth/") ||
    // Eve service routes authenticate their own signed webhook requests.
    pathname.startsWith("/eve/v1/") ||
    pathname === "/api/goforay/conversations" ||
    // Eve's channels deploy as a separate bundle that cannot resolve next/og,
    // so Linq paints cards through this route. It authenticates with a shared
    // secret rather than a browser session.
    pathname === "/api/job-card-png"
  );
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (await getAuthSession(request.headers)) return NextResponse.next();

  const signInUrl = new URL("/sign-in", request.url);
  signInUrl.searchParams.set(
    "callbackUrl",
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  );
  return NextResponse.redirect(signInUrl);
}

export const config = {
  // Workflow's own transport (POST /.well-known/workflow/v1/flow) carries no
  // browser session, so redirecting it to /sign-in would break run resumption.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.well-known/workflow/).*)",
  ],
};
