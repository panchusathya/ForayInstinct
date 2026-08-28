import {
  index,
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
    candidateId: text("candidate_id").notNull(),
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
