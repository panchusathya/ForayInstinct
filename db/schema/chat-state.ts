import {
  bigserial,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Chat SDK's durable Linq state. These tables intentionally do not reference
// Better Auth users: an inbound message may arrive before we can resolve the
// sender to a GoForay account, and the provider thread is the state boundary.
export const chatStateSubscriptions = pgTable("chat_state_subscriptions", {
  threadId: text("thread_id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const chatStateLocks = pgTable("chat_state_locks", {
  threadId: text("thread_id").primaryKey(),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const chatStateValues = pgTable("chat_state_values", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const chatStateQueue = pgTable("chat_state_queue", {
  sequence: bigserial("sequence", { mode: "number" }).primaryKey(),
  threadId: text("thread_id").notNull(),
  entry: jsonb("entry").notNull(),
});
