import { NextResponse, type NextRequest } from "next/server";
import { getAuthSession } from "@/auth/session";

/** Cookie-free entrypoints. Each handler still enforces its own credential. */
export function isPublicPath(pathname: string) {
  return (
    pathname === "/sign-in" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/eve/v1/") ||
    pathname === "/api/goforay/conversations"
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
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
