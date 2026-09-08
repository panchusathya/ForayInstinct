import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { scopesForAuthUser } from "@/lib/access-scope";
import { getAuthSession } from "@/auth/session";
import { env } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(env.BETTER_AUTH_URL),
  title: "OpenInstinct",
  description:
    "A self-hosted personal agent with private credentials and managed browser execution.",
};

export default async function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const session = await getAuthSession(await headers());
  // The canonical workspace, the same one the API routes resolve: the page
  // used to stamp the pre-phone personal id, so client-side state keyed by
  // it never lined up with the workspace the server was writing to.
  const workspaceId = session?.user
    ? scopesForAuthUser(session.user).scope.workspaceId
    : undefined;

  return (
    <html lang="en">
      <body data-workspace-id={workspaceId}>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
