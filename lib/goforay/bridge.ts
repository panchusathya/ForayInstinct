import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, goforayConversations, goforayLinks } from "@/db";
import { env } from "@/lib/env";
import type { AccessScope } from "@/lib/access-scope";
import { searchExaRoles, type ExaRoleCard } from "./exa";

const issuer = "goforay-openinstinct";
const juiceboxAudience = "juicebox";
const openInstinctAudience = "openinstinct";

interface Identity {
  kind: "email" | "phone";
  value: string;
  verified: true;
}

const bridgeClaimSchema = z.object({
  aud: z.string(),
  candidate: z.string().optional(),
  exp: z.number(),
  iss: z.literal(issuer),
  org: z.string().optional(),
  sub: z.string(),
});

const identityLinkResponseSchema = z.object({
  candidate_id: z.string().optional(),
  detail: z.string().optional(),
  org_id: z.string().optional(),
});

const bridgeErrorResponseSchema = z.object({ detail: z.string().optional() });
const resumeUploadSchema = z.object({
  filename: z.string(),
  id: z.string(),
  status: z.string(),
});

const bridgeTaskSchema = z.object({
  application_id: z.string(),
  apply_url: z.string(),
  documents: z.array(
    z.object({
      content_type: z.string(),
      download_url: z.string(),
      filename: z.string(),
      id: z.string(),
    })
  ),
  form_answers: z.array(z.record(z.string(), z.unknown())),
  id: z.string(),
  result: z.record(z.string(), z.unknown()),
  status: z.string(),
});

const jobFeedSchema = z.object({
  cards: z.array(
    z.object({
      company: z.string(),
      location: z.string(),
      posting_id: z.string(),
      reasons: z.array(z.string()),
      title: z.string(),
      url: z.string(),
    })
  ),
});

function authUserId(userId: string) {
  return userId.replace(/^better-auth:/u, "");
}

function externalUserId(userId: string) {
  return `better-auth:${authUserId(userId)}`;
}

function configured() {
  if (!env.JUICEBOX_API_URL || !env.OPENINSTINCT_SHARED_SECRET) {
    throw new Error("GoForay integration is not configured.");
  }
  return {
    apiUrl: env.JUICEBOX_API_URL,
    secret: env.OPENINSTINCT_SHARED_SECRET,
  };
}

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

export function createBridgeToken({
  audience,
  subject,
  candidateId,
  orgId,
  identities,
}: {
  audience: typeof juiceboxAudience | typeof openInstinctAudience;
  subject: string;
  candidateId?: string;
  orgId?: string;
  identities?: Identity[];
}) {
  const { secret } = configured();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    aud: audience,
    sub: subject,
    iat: now,
    exp: now + 300,
    ...(candidateId ? { candidate: candidateId } : {}),
    ...(orgId ? { org: orgId } : {}),
    ...(identities?.length ? { identities } : {}),
  };
  const encodedHeader = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signed = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret)
    .update(signed)
    .digest("base64url");
  return `${signed}.${signature}`;
}

export function verifyBridgeToken(
  token: string,
  audience: typeof openInstinctAudience
) {
  const { secret } = configured();
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature)
    throw new Error("Malformed bridge token.");
  const expected = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  const expectedBytes = Buffer.from(expected);
  const signatureBytes = Buffer.from(signature);
  if (
    expectedBytes.length !== signatureBytes.length ||
    !timingSafeEqual(expectedBytes, signatureBytes)
  ) {
    throw new Error("Invalid bridge token.");
  }
  const decoded = bridgeClaimSchema.safeParse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  );
  if (
    !decoded.success ||
    decoded.data.aud !== audience ||
    decoded.data.exp < Math.floor(Date.now() / 1000)
  ) {
    throw new Error("Expired or mis-scoped bridge token.");
  }
  return decoded.data;
}

export async function linkCandidate({
  userId,
  identities,
}: {
  userId: string;
  identities: Identity[];
}) {
  const { apiUrl } = configured();
  const email =
    identities.find((identity) => identity.kind === "email")?.value ?? "";
  const phone =
    identities.find((identity) => identity.kind === "phone")?.value ?? "";
  const response = await fetch(
    `${apiUrl}/v1/internal/openinstinct/identity-links`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${createBridgeToken({
          audience: juiceboxAudience,
          subject: externalUserId(userId),
          identities,
        })}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        external_user_id: externalUserId(userId),
        email,
        phone,
      }),
    }
  );
  const payload = identityLinkResponseSchema.parse(await response.json());
  if (!response.ok || !payload.org_id || !payload.candidate_id) {
    // A recruiter may deliberately reset a candidate in JuiceBox. Drop the
    // local pointer when the service confirms that the old identity no longer
    // maps to a candidate, so the next text starts with no stale CRM context.
    if (
      response.status === 409 &&
      payload.detail === "No candidate matches this verified identity"
    ) {
      await db
        .delete(goforayLinks)
        .where(eq(goforayLinks.userId, authUserId(userId)));
    }
    throw new Error(payload.detail ?? "Unable to link this GoForay account.");
  }
  await db
    .insert(goforayLinks)
    .values({
      userId: authUserId(userId),
      orgId: payload.org_id,
      candidateId: payload.candidate_id,
    })
    .onConflictDoUpdate({
      target: goforayLinks.userId,
      set: { orgId: payload.org_id, candidateId: payload.candidate_id },
    });
  return { org_id: payload.org_id, candidate_id: payload.candidate_id };
}

export async function linkedCandidate(scope: AccessScope) {
  return db.query.goforayLinks.findFirst({
    where: eq(goforayLinks.userId, authUserId(scope.userId)),
  });
}

async function juiceboxRequest(
  scope: AccessScope,
  path: string,
  init: RequestInit = {}
) {
  const link = await linkedCandidate(scope);
  if (!link)
    throw new Error(
      "Link your GoForay account before starting an application task."
    );
  const { apiUrl } = configured();
  const headers = new Headers(init.headers);
  headers.set(
    "Authorization",
    `Bearer ${createBridgeToken({
      audience: juiceboxAudience,
      subject: externalUserId(scope.userId),
      orgId: link.orgId,
      candidateId: link.candidateId,
    })}`
  );
  headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      bridgeErrorResponseSchema.safeParse(payload).data?.detail ??
        "JuiceBox request failed."
    );
  }
  return payload;
}

export async function createApplicationTask(
  scope: AccessScope,
  jobPostingId: string,
  conversationUrl = ""
) {
  return bridgeTaskSchema.parse(
    await juiceboxRequest(
      scope,
      "/v1/internal/openinstinct/application-tasks",
      {
        method: "POST",
        body: JSON.stringify({
          external_task_id: randomUUID(),
          job_posting_id: jobPostingId,
          conversation_url: conversationUrl,
        }),
      }
    )
  );
}

/** Uploads a candidate-owned resume without making its bytes model-visible. */
export async function uploadCandidateResume(scope: AccessScope, file: File) {
  const link = await linkedCandidate(scope);
  if (!link)
    throw new Error("Link your GoForay account before uploading a resume.");
  const { apiUrl } = configured();
  const form = new FormData();
  form.set("file", file, file.name || "resume");
  const response = await fetch(`${apiUrl}/v1/internal/openinstinct/resumes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createBridgeToken({
        audience: juiceboxAudience,
        subject: externalUserId(scope.userId),
        orgId: link.orgId,
        candidateId: link.candidateId,
      })}`,
    },
    body: form,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      bridgeErrorResponseSchema.safeParse(payload).data?.detail ??
        "Unable to upload the resume."
    );
  }
  return resumeUploadSchema.parse(payload);
}

/** Reads the linked candidate's current JuiceBox matches without creating an application. */
export async function goforayJobFeed(
  scope: AccessScope,
  {
    query = "",
    location = "",
    limit = 5,
  }: { query?: string; location?: string; limit?: number } = {}
) {
  const params = new URLSearchParams({
    q: query,
    location,
    limit: String(limit),
  });
  return jobFeedSchema.parse(
    await juiceboxRequest(scope, `/v1/internal/openinstinct/job-feed?${params}`)
  );
}

/**
 * Prefer roles already curated in JuiceBox, then discover public openings for
 * a new or unmatched candidate. Exa cards deliberately have no posting id:
 * they are leads to review, not invented CRM applications.
 */
export async function findGoforayRoles(
  scope: AccessScope,
  input: { query?: string; location?: string; limit?: number } = {}
): Promise<{
  cards: (z.infer<typeof jobFeedSchema>["cards"][number] | ExaRoleCard)[];
  source: "juicebox" | "exa";
}> {
  const limit = input.limit ?? 5;
  try {
    const feed = await goforayJobFeed(scope, { ...input, limit });
    if (feed.cards.length) return { ...feed, source: "juicebox" };
  } catch {
    // A new candidate has no JuiceBox link yet; public discovery can still help.
  }
  return {
    cards: await searchExaRoles({ ...input, limit }),
    source: "exa",
  };
}

export async function applicationTask(scope: AccessScope, taskId: string) {
  const task = bridgeTaskSchema.parse(
    await juiceboxRequest(
      scope,
      `/v1/internal/openinstinct/application-tasks/${taskId}`
    )
  );
  return {
    ...task,
    documents: task.documents.map((document) => ({
      ...document,
      access_url: `/api/goforay/application-tasks/${task.id}/documents/${document.id}`,
    })),
  };
}

/**
 * Reads one prepared document through a fresh, candidate-scoped bridge token.
 * The bytes stay within OpenInstinct's server/browser path; no credential is
 * included in this call or in the URL returned to the candidate.
 */
export async function applicationTaskDocument(
  scope: AccessScope,
  taskId: string,
  documentId: string
) {
  const link = await linkedCandidate(scope);
  if (!link)
    throw new Error(
      "Link your GoForay account before reading application documents."
    );
  const { apiUrl } = configured();
  const response = await fetch(
    `${apiUrl}/v1/internal/openinstinct/application-tasks/${taskId}/documents/${documentId}`,
    {
      headers: {
        Authorization: `Bearer ${createBridgeToken({
          audience: juiceboxAudience,
          subject: externalUserId(scope.userId),
          orgId: link.orgId,
          candidateId: link.candidateId,
        })}`,
      },
    }
  );
  if (!response.ok)
    throw new Error("Unable to read the prepared application document.");
  const disposition = response.headers.get("content-disposition") ?? "";
  return {
    bytes: await response.arrayBuffer(),
    contentType:
      response.headers.get("content-type") ?? "application/octet-stream",
    disposition,
    filename: filenameFromDisposition(disposition),
  };
}

function filenameFromDisposition(disposition: string) {
  const match = /filename="?([^";]+)"?/iu.exec(disposition);
  return match?.[1] ?? "";
}

export async function reportApplicationTask(
  scope: AccessScope,
  taskId: string,
  result: {
    status: "submitted" | "needs_human" | "failed";
    error?: string;
    external_id?: string;
    confirmation_ref?: string;
  }
) {
  return bridgeTaskSchema.parse(
    await juiceboxRequest(
      scope,
      `/v1/internal/openinstinct/application-tasks/${taskId}/result`,
      {
        method: "POST",
        body: JSON.stringify({ vendor: "browser", artifacts: [], ...result }),
      }
    )
  );
}

export async function recordConversationMessage({
  scope,
  conversationId,
  channel,
  direction,
  body,
  url = "",
}: {
  scope: AccessScope;
  conversationId: string;
  channel: string;
  direction: "inbound" | "outbound";
  body: string;
  url?: string;
}) {
  const link = await linkedCandidate(scope);
  if (!link || !body.trim()) return;
  const existing = await db.query.goforayConversations.findFirst({
    where: eq(goforayConversations.id, conversationId),
  });
  const entry = {
    id: randomUUID(),
    direction,
    body: body.slice(0, 20_000),
    created_at: new Date().toISOString(),
  };
  if (!existing) {
    await db.insert(goforayConversations).values({
      id: conversationId,
      userId: authUserId(scope.userId),
      candidateId: link.candidateId,
      channel,
      url,
      messages: [entry],
    });
    return;
  }
  await db
    .update(goforayConversations)
    .set({
      messages: [...existing.messages, entry],
      updatedAt: new Date(),
      ...(url ? { url } : {}),
    })
    .where(eq(goforayConversations.id, conversationId));
}

export async function conversationsForCandidate(candidateId: string) {
  return db
    .select()
    .from(goforayConversations)
    .where(eq(goforayConversations.candidateId, candidateId))
    .orderBy(desc(goforayConversations.updatedAt));
}
