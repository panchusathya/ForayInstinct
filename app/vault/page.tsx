import { headers } from "next/headers";
import { ManagerShell } from "@/app/_components/manager-shell";
import { VaultManager } from "@/app/_components/manager/vault";
import { getAuthSession } from "@/auth/session";
import { parseManagerSetupSearchParams } from "@/lib/manager";

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}) {
  const query = await searchParams;
  const requestedSetup = parseManagerSetupSearchParams(query);
  const setup =
    requestedSetup.success && requestedSetup.data.target === "vault"
      ? requestedSetup.data
      : undefined;
  const session = await getAuthSession(await headers());
  const initialIdentifier =
    setup?.kind === "login" && setup.identifierType === "email"
      ? session?.user.emailVerified
        ? session.user.email
        : undefined
      : setup?.kind === "login" && setup.identifierType === "phone"
        ? session?.user.phoneNumberVerified && session.user.phoneNumber
          ? session.user.phoneNumber
          : undefined
        : undefined;

  return (
    <ManagerShell active="vault">
      <VaultManager
        initialIdentifier={initialIdentifier}
        initialSetup={setup}
      />
    </ManagerShell>
  );
}
