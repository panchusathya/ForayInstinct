import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  goforayConversations,
  goforayLinks,
  goforayWorkspaceLinks,
  goforayWorkspaceConversations,
  goforayWorkspaceSyncOutbox,
  goforayPendingRoleSearches,
} from "@/db";
import { env } from "@/lib/env";
import type { AccessScope } from "@/lib/access-scope";
import { ensureScope } from "@/db/services/scope";
import { searchExaRoles } from "./exa";
import { goForayJobCardSchema, type GoForayJobCard } from "./job-cards";
import { relevanceTokens } from "./relevance";
import { roleKeys } from "./role-identity";
import {
  listPresentedRoles,
  rememberPresentedRoles,
} from "@/db/services/goforay-presented-roles";
import {
  completePendingRoleSearch,
  listPendingRoleSearches,
} from "@/db/services/pending-role-searches";

const issuer = "goforay-openinstinct";
const juiceboxAudience = "juicebox";

/**
 * Every call out to JuiceBox is bounded.
 *
 * None of these used to carry a signal, and one of them runs on the inbound
 * webhook for every text a candidate sends. An upstream that accepted the
 * connection and then went quiet held that request until Vercel killed the
 * function at five minutes, and the candidate's message was dropped with no
 * reply and no retry. A slow dependency may cost a feature; it may never cost
 * the turn.
 */
const INBOUND_BRIDGE_TIMEOUT_MS = 5_000;
const BRIDGE_TIMEOUT_MS = 15_000;
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
      signal: AbortSignal.timeout(INBOUND_BRIDGE_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
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
 * Why the curated feed could not answer. A workspace with no candidate link is
 * not degraded — that is the designed top-of-funnel path — but a workspace that
 * holds a link the CRM then rejects is, and used to be indistinguishable.
 */
export interface CuratedFailure {
  from: "juicebox";
  reason: "link_broken" | "not_configured" | "unavailable";
  detail: string;
}

function classifyCuratedFailure(
  error: unknown,
  { linked }: { linked: boolean }
): CuratedFailure | undefined {
  const message = error instanceof Error ? error.message : "";
  const detail = message.slice(0, 200);
  if (/is not configured/iu.test(message))
    return { from: "juicebox", reason: "not_configured", detail };
  if (/not linked|link your goforay account/iu.test(message)) {
    // A candidate who never linked is expected, not broken.
    return linked
      ? { from: "juicebox", reason: "link_broken", detail }
      : undefined;
  }
  return { from: "juicebox", reason: "unavailable", detail };
}

/**
 * Prefer curated JuiceBox roles when a CRM candidate is available. Public
 * discovery remains available for every workspace, including top-of-funnel
 * users who do not have a JuiceBox candidate yet.
 *
 * Both sources exclude roles this workspace has already been shown, so a
 * follow-on batch is genuinely new. `exhausted` is the honest answer when
 * nothing new is left, and it is never padded with an earlier role.
 */
export async function findGoforayRoles(
  scope: AccessScope,
  input: {
    query?: string;
    location?: string;
    limit?: number;
    role?: string;
    seniority?: string;
  } = {}
): Promise<{
  cards: GoForayJobCard[];
  searching: boolean;
  source: "exa" | "juicebox";
  degraded?: CuratedFailure;
  exhausted?: boolean;
  discovery?: z.infer<typeof jobFeedSchema>["discovery"];
  unavailable?: string;
}> {
  const limit = input.limit ?? 5;
  const presented = await listPresentedRoles(scope);
  // Whether a link exists decides only how a curated failure is classified, so
  // a failed lookup degrades to the public path rather than failing the search.
  const link = await linkedCandidate(scope).catch(() => undefined);
  let degraded: CuratedFailure | undefined;

  if (link) {
    try {
      const feed = await goforayJobFeed(scope, {
        query: input.query,
        location: input.location,
        limit,
        excludePostingIds: presented.postingIds,
      });
      // A background search that is about to answer must not be replaced by web
      // results; the pending-search poller delivers its cards when it lands.
      if (
        feed.discovery?.state === "queued" ||
        feed.discovery?.state === "running"
      ) {
        return { ...feed, searching: true, source: "juicebox" };
      }
      // The feed's own exclusion is capped, so re-check locally. Check every
      // identity the card could have been recorded under: this posting may have
      // been shown before as a public hit, which carries no posting id.
      const fresh = feed.cards.filter(
        (card) => !roleKeys(card).some((key) => presented.keys.has(key))
      );
      if (fresh.length) {
        await rememberPresentedRoles(scope, fresh);
        return {
          cards: fresh,
          searching: false,
          source: "juicebox",
          discovery: feed.discovery,
        };
      }
    } catch (error) {
      degraded = classifyCuratedFailure(error, { linked: true });
      // Nothing logged this before: the feed degraded silently for as long as
      // it liked, and the only visible symptom was public results arriving as
      // though they were curated matches.
      console.error("[goforay] curated role feed unavailable", {
        reason: degraded?.reason ?? "not_linked",
        workspaceId: scope.workspaceId,
      });
    }
  }

  const role = (input.role?.trim() ?? "") || (input.query?.trim() ?? "");
  try {
    // Over-fetch: both the relevance gate and the already-shown filter remove
    // hits, and public search offers neither an offset nor an exclusion, so a
    // repeat search returns the same top results.
    const candidates = await searchExaRoles({
      query: role || "current professional roles",
      location: (input.location?.trim() ?? "") || "remote",
      limit: Math.min(limit * 4, 25),
      wanted: relevanceTokens(role, input.seniority),
    });
    const cards = candidates
      .filter((card) => !roleKeys(card).some((key) => presented.keys.has(key)))
      .slice(0, limit);
    if (cards.length) await rememberPresentedRoles(scope, cards);
    return {
      cards,
      searching: false,
      source: "exa",
      ...(cards.length ? {} : { exhausted: true }),
      ...(degraded ? { degraded } : {}),
    };
  } catch (error) {
    return {
      cards: [],
      searching: false,
      source: "exa",
      ...(degraded ? { degraded } : {}),
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
        message: `A background JuiceBox role search has completed. Send these openings to the candidate as concise numbered cards with their apply URLs; do not run another search or use web_search:\n${JSON.stringify(feed.cards)}`,
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
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
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

/**
 * The next batch for the criteria already in play.
 *
 * Delegates rather than reading the feed itself. It used to be the only
 * deduping path *and* the only one that threw: when the CRM rejected the link
 * it surfaced to the model as a failed tool, and the model answered a request
 * for more roles with a generic web search instead. It also searched with an
 * empty query, so even its happy path was an unfiltered feed read.
 */
export async function nextGoforayRoles(
  scope: AccessScope,
  input: {
    query?: string;
    location?: string;
    limit?: number;
    role?: string;
    seniority?: string;
  } = {}
) {
  return findGoforayRoles(scope, {
    ...input,
    limit: Math.min(input.limit ?? 5, 5),
  });
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
