import {
  conversationsForCandidate,
  verifyBridgeToken,
} from "@/lib/goforay/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Service-only recruiter timeline feed. The signed claim is the candidate scope. */
export async function GET(request: Request) {
  const candidateId = new URL(request.url).searchParams.get("candidate_id");
  const token = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/iu, "");
  if (!candidateId || !token)
    return Response.json({ error: "Unauthorized." }, { status: 401 });

  try {
    const claim = verifyBridgeToken(token, "openinstinct");
    if (claim.candidate !== candidateId) {
      return Response.json(
        { error: "Candidate scope mismatch." },
        { status: 403 }
      );
    }
    const conversations = await conversationsForCandidate(candidateId);
    return Response.json({
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        channel: conversation.channel,
        url: conversation.url,
        messages: conversation.messages,
        updated_at: conversation.updatedAt.toISOString(),
      })),
    });
  } catch {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
}
