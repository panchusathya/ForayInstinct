import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { workspaces } from "./application";

/** Canonical JuiceBox link for phone-backed candidate workspaces. */
export const goforayWorkspaceLinks = pgTable(
  "goforay_workspace_links",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    candidateId: text("candidate_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("goforay_workspace_links_org_candidate_uidx").on(
      table.orgId,
      table.candidateId
    ),
  ]
);

/**
 * Every role already shown from this workspace, so a follow-on batch is
 * genuinely new. Keyed source-agnostically (`posting:<id>` or `url:<...>`)
 * because public-market roles have no posting id, which is why the older
 * posting-id-only table could never exclude them.
 *
 * `postingId` is denormalised rather than parsed back out of `roleKey`: the
 * JuiceBox feed takes a plain list of ids to exclude.
 */
export const goforayWorkspacePresentedRoles = pgTable(
  "goforay_workspace_presented_roles",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    roleKey: text("role_key").notNull(),
    postingId: text("posting_id").notNull().default(""),
    url: text("url").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.roleKey] }),
    index("goforay_workspace_presented_roles_recent_idx").on(
      table.workspaceId,
      table.createdAt
    ),
  ]
);

/** Postings shown from a phone-backed workspace, independent of web login. */
export const goforayWorkspacePresentedPostings = pgTable(
  "goforay_workspace_presented_postings",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    postingId: text("posting_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("goforay_workspace_presented_postings_unique").on(
      table.workspaceId,
      table.postingId
    ),
  ]
);

/** Last known Linq thread plus the queued search that should reply there. */
export const goforayPendingRoleSearches = pgTable(
  "goforay_pending_role_searches",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    query: text("query").notNull().default(""),
    location: text("location").notNull().default(""),
    pending: text("pending").notNull().default(""),
    phone: text("phone").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  }
);

export const goforayWorkspaceConversations = pgTable(
  "goforay_workspace_conversations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    candidateId: text("candidate_id"),
    channel: text("channel").notNull(),
    url: text("url").notNull().default(""),
    messages: jsonb("messages")
      .$type<
        {
          id: string;
          direction: "inbound" | "outbound";
          body: string;
          created_at: string;
        }[]
      >()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("goforay_workspace_conversations_candidate_idx").on(
      table.candidateId,
      table.updatedAt
    ),
  ]
);

export const goforayWorkspaceSyncOutbox = pgTable(
  "goforay_workspace_sync_outbox",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    candidateId: text("candidate_id"),
    conversationId: text("conversation_id").notNull(),
    channel: text("channel").notNull(),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    body: text("body").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("goforay_workspace_sync_outbox_pending_idx").on(
      table.sentAt,
      table.createdAt
    ),
  ]
);

export const goforayLinks = pgTable(
  "goforay_links",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    candidateId: text("candidate_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("goforay_links_org_candidate_uidx").on(
      table.orgId,
      table.candidateId
    ),
  ]
);

export const goforayConversations = pgTable(
  "goforay_conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    candidateId: text("candidate_id"),
    channel: text("channel").notNull(),
    url: text("url").notNull().default(""),
    messages: jsonb("messages")
      .$type<
        {
          id: string;
          direction: "inbound" | "outbound";
          body: string;
          created_at: string;
        }[]
      >()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("goforay_conversations_candidate_idx").on(
      table.candidateId,
      table.updatedAt
    ),
  ]
);

/** Durable service-to-service delivery queue for the JuiceBox text mirror. */
export const goforaySyncOutbox = pgTable(
  "goforay_sync_outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    candidateId: text("candidate_id"),
    conversationId: text("conversation_id").notNull(),
    channel: text("channel").notNull(),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    body: text("body").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("goforay_sync_outbox_pending_idx").on(table.sentAt, table.createdAt),
  ]
);

/** Roles already shown to a candidate; follow-on batches must be genuinely new. */
export const goforayPresentedPostings = pgTable(
  "goforay_presented_postings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    postingId: text("posting_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("goforay_presented_postings_user_idx").on(
      table.userId,
      table.createdAt
    ),
  ]
);
