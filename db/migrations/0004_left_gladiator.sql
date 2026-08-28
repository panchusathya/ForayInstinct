CREATE TABLE IF NOT EXISTS "chat_state_locks" (
  "thread_id" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_state_queue" (
  "sequence" bigserial PRIMARY KEY NOT NULL,
  "thread_id" text NOT NULL,
  "entry" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_state_subscriptions" (
  "thread_id" text PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_state_values" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "expires_at" timestamp with time zone
);
