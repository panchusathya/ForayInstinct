import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  goforayConversations,
  goforayLinks,
  goforayPresentedPostings,
  goforaySyncOutbox,
  user,
} from "@/db";
import { env } from "@/lib/env";
import type { AccessScope } from "@/lib/access-scope";

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
  searching: z.boolean().optional().default(false),
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

function createBridgeToken({
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
  name = "",
}: {
  userId: string;
  identities: Identity[];
  name?: string;
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
        name,
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

async function linkedCandidate(scope: AccessScope) {
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
    throw new Error("Link your GoForay account before calling JuiceBox.");
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

/** Reads the linked candidate's current JuiceBox matches without creating an application. */
async function goforayJobFeed(
  scope: AccessScope,
  {
    query = "",
    location = "",
    limit = 5,
    excludePostingIds = [],
  }: {
    query?: string;
    location?: string;
    limit?: number;
    excludePostingIds?: string[];
  } = {}
) {
  const params = new URLSearchParams({
    q: query,
    location,
    limit: String(limit),
  });
  for (const postingId of excludePostingIds.slice(0, 100)) {
    params.append("exclude_posting_id", postingId);
  }
  return jobFeedSchema.parse(
    await juiceboxRequest(scope, `/v1/internal/openinstinct/job-feed?${params}`)
  );
}

/** Candidate-authorized PNG from JuiceBox's canonical job-card renderer. */
export async function goforayJobCardPng(
  scope: AccessScope,
  postingId: string,
  index: number,
  total: number
) {
  const link = await linkedCandidate(scope);
  if (!link)
    throw new Error("Link your GoForay account before loading a job card.");
  const { apiUrl } = configured();
  const response = await fetch(
    `${apiUrl}/v1/internal/openinstinct/job-cards/${encodeURIComponent(postingId)}?index=${index}&total=${total}`,
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
  if (!response.ok) throw new Error("JuiceBox job card is unavailable.");
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Ask JuiceBox for roles. JuiceBox owns Exa discovery: an empty book queues
 * the same search the messaging bot uses, then later asks match against what
 * it ingested. Foray never searches Exa itself and never invents a posting.
 */
export async function findGoforayRoles(
  scope: AccessScope,
  input: { query?: string; location?: string; limit?: number } = {}
): Promise<{
  cards: z.infer<typeof jobFeedSchema>["cards"];
  searching: boolean;
  source: "juicebox";
  unavailable?: string;
}> {
  const limit = input.limit ?? 5;
  try {
    configured();
    const feed = await goforayJobFeed(scope, { ...input, limit });
    if (feed.cards.length) {
      await rememberPresentedRoles(scope, feed.cards);
    }
    return { ...feed, searching: feed.searching, source: "juicebox" };
  } catch (error) {
    return {
      cards: [],
      searching: false,
      source: "juicebox",
      unavailable:
        error instanceof Error ? error.message : "Role search is unavailable.",
    };
  }
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

/**
 * Reads the candidate's parsed protected default resume for a direct external
 * application. The worker stages these bytes in Kernel; models receive only
 * the resulting local file path.
 */
export async function candidateDefaultResume(scope: AccessScope) {
  const link = await linkedCandidate(scope);
  if (!link)
    throw new Error(
      "Link your GoForay account before reading the protected default resume."
    );
  const { apiUrl } = configured();
  const response = await fetch(
    `${apiUrl}/v1/internal/openinstinct/resumes/default`,
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
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined);
    throw new Error(
      bridgeErrorResponseSchema.safeParse(payload).data?.detail ??
        "The protected default resume is unavailable. Attach a PDF or DOCX to continue."
    );
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  return {
    bytes: await response.arrayBuffer(),
    filename: filenameFromDisposition(disposition) || "resume.pdf",
  };
}

function filenameFromDisposition(disposition: string) {
  const match = /filename="?([^";]+)"?/iu.exec(disposition);
  return match?.[1] ?? "";
}

export async function recordConversationMessage({
  scope,
  conversationId,
  channel,
  direction,
  body,
  sourceMessageId,
  url = "",
}: {
  scope: AccessScope;
  conversationId: string;
  channel: string;
  direction: "inbound" | "outbound";
  body: string;
  /** Stable channel/provider id. Required for retry-safe mirroring. */
  sourceMessageId?: string;
  url?: string;
}) {
  const link = await linkedCandidate(scope);
  if (!body.trim()) return;
  const sourceId = sourceMessageId?.slice(0, 300);
  const entry = {
    id: sourceId ?? randomUUID(),
    direction,
    body: body.slice(0, 20_000),
    created_at: new Date().toISOString(),
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(goforayConversations)
      .values({
        id: conversationId,
        userId: authUserId(scope.userId),
        candidateId: link?.candidateId,
        channel,
        url,
        messages: [entry],
      })
      .onConflictDoNothing();
    const [existing] = await tx
      .select()
      .from(goforayConversations)
      .where(eq(goforayConversations.id, conversationId))
      .for("update");
    if (!existing) return;
    if (!existing.messages.some((message) => message.id === entry.id)) {
      await tx
        .update(goforayConversations)
        .set({
          messages: [...existing.messages, entry],
          updatedAt: new Date(),
          ...(url ? { url } : {}),
        })
        .where(eq(goforayConversations.id, conversationId));
    }
    await tx
      .insert(goforaySyncOutbox)
      .values({
        id: entry.id,
        userId: authUserId(scope.userId),
        candidateId: link?.candidateId,
        conversationId,
        channel,
        direction,
        body: entry.body,
      })
      .onConflictDoNothing();
  });
  // The local conversation and outbox are committed before the bridge call.
  // Do not make a web or iMessage reply wait for JuiceBox to be reachable.
  void syncConversationEvent(entry.id);
}

async function candidateProfile(userId: string) {
  const account = await db.query.user.findFirst({ where: eq(user.id, userId) });
  if (!account) return { name: "", identities: [] as Identity[] };
  const identities: Identity[] = [];
  if (account.emailVerified && account.email) {
    identities.push({ kind: "email", value: account.email, verified: true });
  }
  if (account.phoneNumberVerified && account.phoneNumber) {
    identities.push({
      kind: "phone",
      value: account.phoneNumber,
      verified: true,
    });
  }
  return { name: account.name, identities };
}

async function syncConversationEvent(id: string) {
  const item = await db.query.goforaySyncOutbox.findFirst({
    where: eq(goforaySyncOutbox.id, id),
  });
  if (!item || item.sentAt) return;
  try {
    const profile = await candidateProfile(item.userId);
    if (!profile.identities.length)
      throw new Error("No verified candidate identity available.");
    const { apiUrl } = configured();
    const response = await fetch(
      `${apiUrl}/v1/internal/openinstinct/conversation-events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${createBridgeToken({
            audience: juiceboxAudience,
            subject: externalUserId(item.userId),
            ...(item.candidateId ? { candidateId: item.candidateId } : {}),
            identities: profile.identities,
          })}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          conversation_id: item.conversationId,
          provider_native_id: item.id,
          direction: item.direction,
          body: item.body,
          channel: item.channel,
          display_name: profile.name,
        }),
      }
    );
    if (!response.ok) {
      const payload = bridgeErrorResponseSchema.safeParse(
        await response.json()
      ).data;
      throw new Error(
        payload?.detail ?? `JuiceBox mirror failed (${response.status}).`
      );
    }
    await db
      .update(goforaySyncOutbox)
      .set({
        sentAt: new Date(),
        lastError: "",
        attempts: sql`${goforaySyncOutbox.attempts} + 1`,
      })
      .where(eq(goforaySyncOutbox.id, item.id));
  } catch (error) {
    await db
      .update(goforaySyncOutbox)
      .set({
        attempts: sql`${goforaySyncOutbox.attempts} + 1`,
        lastError:
          error instanceof Error
            ? error.message.slice(0, 1_000)
            : "JuiceBox mirror failed.",
      })
      .where(eq(goforaySyncOutbox.id, item.id));
  }
}

/** Fresh, curated roles after a candidate starts an application. */
export async function nextGoforayRoles(scope: AccessScope, limit = 5) {
  const userId = authUserId(scope.userId);
  const shown = await db
    .select({ postingId: goforayPresentedPostings.postingId })
    .from(goforayPresentedPostings)
    .where(eq(goforayPresentedPostings.userId, userId))
    .orderBy(desc(goforayPresentedPostings.createdAt))
    .limit(100);
  const feed = await goforayJobFeed(scope, {
    limit: Math.min(limit, 5),
    excludePostingIds: shown.map((row) => row.postingId),
  });
  await rememberPresentedRoles(scope, feed.cards);
  return feed;
}

async function rememberPresentedRoles(
  scope: AccessScope,
  cards: z.infer<typeof jobFeedSchema>["cards"]
) {
  const userId = authUserId(scope.userId);
  await Promise.all(
    cards.map((card) =>
      db
        .insert(goforayPresentedPostings)
        .values({
          id: `${userId}:${card.posting_id}`,
          userId,
          postingId: card.posting_id,
        })
        .onConflictDoNothing()
    )
  );
}

/** Retry durable conversation events without delaying an active candidate turn. */
export async function flushConversationSyncOutbox(limit = 50) {
  const rows = await db
    .select({ id: goforaySyncOutbox.id })
    .from(goforaySyncOutbox)
    .where(isNull(goforaySyncOutbox.sentAt))
    .orderBy(asc(goforaySyncOutbox.createdAt))
    .limit(limit);
  await Promise.all(rows.map((row) => syncConversationEvent(row.id)));
}

export async function conversationsForCandidate(candidateId: string) {
  return db
    .select()
    .from(goforayConversations)
    .where(eq(goforayConversations.candidateId, candidateId))
    .orderBy(desc(goforayConversations.updatedAt));
}
