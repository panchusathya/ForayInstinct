import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  goforayConversations,
  goforayLinks,
  goforayWorkspaceLinks,
  goforayWorkspaceConversations,
  goforayWorkspacePresentedPostings,
  goforayWorkspaceSyncOutbox,
  goforayPendingRoleSearches,
} from "@/db";
import { env } from "@/lib/env";
import type { AccessScope } from "@/lib/access-scope";
import { ensureScope } from "@/db/services/scope";
import { searchExaRoles } from "./exa";
import { goForayJobCardSchema, type GoForayJobCard } from "./job-cards";
import {
  completePendingRoleSearch,
  listPendingRoleSearches,
  queuePendingRoleSearch,
} from "@/db/services/pending-role-searches";

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
    goForayJobCardSchema.extend({
      posting_id: z.string(),
    })
  ),
  searching: z.boolean().optional().default(false),
  discovery: z
    .object({
      state: z.enum([
        "queued",
        "running",
        "ready",
        "empty",
        "unavailable",
        "failed",
      ]),
      detail: z.string().optional(),
      job_id: z.string().optional(),
    })
    .optional(),
});

function authUserId(userId: string) {
  return userId.replace(/^better-auth:/u, "");
}

function externalUserId(userId: string) {
  return userId.startsWith("phone:")
    ? userId
    : `better-auth:${authUserId(userId)}`;
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
  scope,
  identities,
  name = "",
}: {
  scope: AccessScope;
  identities: Identity[];
  name?: string;
}) {
  await ensureScope(scope);
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
          subject: externalUserId(scope.userId),
          identities,
        })}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        external_user_id: externalUserId(scope.userId),
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
        .delete(goforayWorkspaceLinks)
        .where(eq(goforayWorkspaceLinks.workspaceId, scope.workspaceId));
    }
    throw new Error(payload.detail ?? "Unable to link this GoForay account.");
  }
  await db
    .insert(goforayWorkspaceLinks)
    .values({
      workspaceId: scope.workspaceId,
      orgId: payload.org_id,
      candidateId: payload.candidate_id,
    })
    .onConflictDoUpdate({
      target: goforayWorkspaceLinks.workspaceId,
      set: { orgId: payload.org_id, candidateId: payload.candidate_id },
    });
  return { org_id: payload.org_id, candidate_id: payload.candidate_id };
}

async function linkedCandidate(scope: AccessScope) {
  const canonical = await db.query.goforayWorkspaceLinks.findFirst({
    where: eq(goforayWorkspaceLinks.workspaceId, scope.workspaceId),
  });
  if (canonical) return canonical;
  if (!scope.userId.startsWith("better-auth:")) return;
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

/**
 * Prefer curated JuiceBox roles when a CRM candidate is available. Public
 * discovery remains available for every workspace, including top-of-funnel
 * users who do not have a JuiceBox candidate yet.
 */
export async function findGoforayRoles(
  scope: AccessScope,
  input: { query?: string; location?: string; limit?: number } = {}
): Promise<{
  cards: GoForayJobCard[];
  searching: boolean;
  source: "exa" | "juicebox";
  discovery?: z.infer<typeof jobFeedSchema>["discovery"];
  unavailable?: string;
}> {
  const limit = input.limit ?? 5;
  try {
    const feed = await goforayJobFeed(scope, { ...input, limit });
    if (feed.cards.length) {
      await rememberPresentedRoles(scope, feed.cards);
      return {
        ...feed,
        searching: false,
        source: "juicebox",
      };
    }
  } catch {
    // A missing candidate association or unavailable CRM must not block the
    // top-of-funnel role-search experience.
  }

  try {
    return {
      cards: await searchExaRoles({
        query: input.query?.trim() || "current professional roles",
        location: input.location?.trim() || "remote",
        limit,
      }),
      searching: false,
      source: "exa",
    };
  } catch (error) {
    return {
      cards: [],
      searching: false,
      source: "exa",
      unavailable:
        error instanceof Error ? error.message : "Role search is unavailable.",
    };
  }
}

/** Polls queued phone-scoped searches so Linq can proactively resume them. */
export async function pollPendingGoforayRoleSearches(limit = 20) {
  const pending = await listPendingRoleSearches(limit);
  const deliveries: {
    message: string;
    scope: AccessScope;
    threadId: string;
    workspaceId: string;
  }[] = [];
  for (const search of pending) {
    const scope = {
      userId: search.workspaceId,
      workspaceId: search.workspaceId,
    } satisfies AccessScope;
    const feed = await findGoforayRoles(scope, {
      location: search.location,
      query: search.query,
    });
    if (feed.searching) continue;
    await completePendingRoleSearch(search.workspaceId);
    if (feed.cards.length) {
      deliveries.push({
        message: `A background JuiceBox role search has completed. Send these verified openings to the candidate as concise numbered cards with their apply URLs; do not run another search or use web_search:\n${JSON.stringify(feed.cards)}`,
        scope,
        threadId: search.threadId,
        workspaceId: search.workspaceId,
      });
    } else if (feed.unavailable) {
      deliveries.push({
        message: `The background JuiceBox role search could not run: ${feed.unavailable}. Tell the candidate clearly, without using web_search.`,
        scope,
        threadId: search.threadId,
        workspaceId: search.workspaceId,
      });
    }
  }
  return deliveries;
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
      .insert(goforayWorkspaceConversations)
      .values({
        id: conversationId,
        workspaceId: scope.workspaceId,
        candidateId: link?.candidateId,
        channel,
        url,
        messages: [entry],
      })
      .onConflictDoNothing();
    const [existing] = await tx
      .select()
      .from(goforayWorkspaceConversations)
      .where(eq(goforayWorkspaceConversations.id, conversationId))
      .for("update");
    if (!existing) return;
    if (!existing.messages.some((message) => message.id === entry.id)) {
      await tx
        .update(goforayWorkspaceConversations)
        .set({
          messages: [...existing.messages, entry],
          updatedAt: new Date(),
          ...(url ? { url } : {}),
        })
        .where(eq(goforayWorkspaceConversations.id, conversationId));
    }
    await tx
      .insert(goforayWorkspaceSyncOutbox)
      .values({
        id: entry.id,
        workspaceId: scope.workspaceId,
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

async function candidateProfile(workspaceId: string) {
  const thread = await db.query.goforayPendingRoleSearches.findFirst({
    where: eq(goforayPendingRoleSearches.workspaceId, workspaceId),
  });
  const phone = thread?.phone ?? "";
  return {
    name: "",
    identities: phone
      ? ([{ kind: "phone", value: phone, verified: true }] satisfies Identity[])
      : ([] satisfies Identity[]),
  };
}

async function syncConversationEvent(id: string) {
  const item = await db.query.goforayWorkspaceSyncOutbox.findFirst({
    where: eq(goforayWorkspaceSyncOutbox.id, id),
  });
  if (!item || item.sentAt) return;
  try {
    const profile = await candidateProfile(item.workspaceId);
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
            subject: externalUserId(item.workspaceId),
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
      .update(goforayWorkspaceSyncOutbox)
      .set({
        sentAt: new Date(),
        lastError: "",
        attempts: sql`${goforayWorkspaceSyncOutbox.attempts} + 1`,
      })
      .where(eq(goforayWorkspaceSyncOutbox.id, item.id));
  } catch (error) {
    await db
      .update(goforayWorkspaceSyncOutbox)
      .set({
        attempts: sql`${goforayWorkspaceSyncOutbox.attempts} + 1`,
        lastError:
          error instanceof Error
            ? error.message.slice(0, 1_000)
            : "JuiceBox mirror failed.",
      })
      .where(eq(goforayWorkspaceSyncOutbox.id, item.id));
  }
}

/** Fresh, curated roles after a candidate starts an application. */
export async function nextGoforayRoles(scope: AccessScope, limit = 5) {
  const shown = await db
    .select({ postingId: goforayWorkspacePresentedPostings.postingId })
    .from(goforayWorkspacePresentedPostings)
    .where(eq(goforayWorkspacePresentedPostings.workspaceId, scope.workspaceId))
    .orderBy(desc(goforayWorkspacePresentedPostings.createdAt))
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
  await Promise.all(
    cards.map((card) =>
      db
        .insert(goforayWorkspacePresentedPostings)
        .values({
          id: `${scope.workspaceId}:${card.posting_id}`,
          workspaceId: scope.workspaceId,
          postingId: card.posting_id,
        })
        .onConflictDoNothing({
          target: [
            goforayWorkspacePresentedPostings.workspaceId,
            goforayWorkspacePresentedPostings.postingId,
          ],
        })
    )
  );
}

/** Retry durable conversation events without delaying an active candidate turn. */
export async function flushConversationSyncOutbox(limit = 50) {
  const rows = await db
    .select({ id: goforayWorkspaceSyncOutbox.id })
    .from(goforayWorkspaceSyncOutbox)
    .where(isNull(goforayWorkspaceSyncOutbox.sentAt))
    .orderBy(asc(goforayWorkspaceSyncOutbox.createdAt))
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
