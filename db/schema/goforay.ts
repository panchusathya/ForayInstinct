import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

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
