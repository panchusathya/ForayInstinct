import { headers } from "next/headers";
import { getAuthSession } from "@/auth/session";
import { normalizeAuthPhoneNumber } from "@/auth/phone-number";
import { accessScopeForPhone } from "@/lib/access-scope";
import { linkCandidate } from "@/lib/goforay/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Links this signed-in candidate to one JuiceBox candidate by verified contact. */
export async function POST() {
  const session = await getAuthSession(await headers());
  if (!session)
    return Response.json({ error: "Sign in to continue." }, { status: 401 });

  const identities = [
    ...(session.user.emailVerified
      ? [
          {
            kind: "email" as const,
            value: session.user.email,
            verified: true as const,
          },
        ]
      : []),
    ...(session.user.phoneNumberVerified && session.user.phoneNumber
      ? [
          {
            kind: "phone" as const,
            value: session.user.phoneNumber,
            verified: true as const,
          },
        ]
      : []),
  ];
  if (!identities.length) {
    return Response.json(
      {
        error:
          "Verify an email address or phone number before linking GoForay.",
      },
      { status: 422 }
    );
  }

  try {
    const phone = normalizeAuthPhoneNumber(session.user.phoneNumber ?? "");
    if (!phone) {
      return Response.json(
        { error: "A verified phone number is required to link GoForay." },
        { status: 422 }
      );
    }
    return Response.json(
      await linkCandidate({ scope: accessScopeForPhone(phone), identities })
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to link GoForay.",
      },
      { status: 400 }
    );
  }
}
