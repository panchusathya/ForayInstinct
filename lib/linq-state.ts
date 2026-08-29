import { randomUUID } from "node:crypto";
import type { Lock, QueueEntry, StateAdapter } from "chat";
import type { Pool, PoolClient } from "pg";
import { pool } from "@/db";

interface StateRow {
  value: unknown;
}

interface LockRow {
  expiresAt: string | number;
  token: string;
}

interface QueueRow {
  entry: QueueEntry;
}

/**
 * A Postgres-backed Chat SDK state adapter.
 *
 * Linq's first-party Eve wrapper currently always uses process memory. That
 * loses a conversation's continuation token and worker checkpoint whenever a
 * Vercel invocation lands on another instance. This adapter gives each Linq
 * provider thread durable subscriptions, locks, state, and queued turns using
 * the application's existing pooled Neon database connection.
 */
export class PostgresStateAdapter implements StateAdapter {
  #connected = false;

  constructor(
    private readonly sql: Pool = pool,
    private readonly namespace = ""
  ) {}

  async connect() {
    if (this.#connected) return;
    await this.sql.query("SELECT 1");
    this.#connected = true;
  }

  async disconnect() {
    // The application owns the shared pool. Closing it here would interrupt
    // unrelated requests running in the same Vercel instance.
    this.#connected = false;
  }

  async subscribe(threadId: string) {
    this.#ensureConnected();
    await this.sql.query(
      `INSERT INTO chat_state_subscriptions (thread_id)
       VALUES ($1)
       ON CONFLICT (thread_id) DO NOTHING`,
      [this.#threadId(threadId)]
    );
  }

  async unsubscribe(threadId: string) {
    this.#ensureConnected();
    await this.sql.query(
      "DELETE FROM chat_state_subscriptions WHERE thread_id = $1",
      [this.#threadId(threadId)]
    );
  }

  async isSubscribed(threadId: string) {
    this.#ensureConnected();
    const result = await this.sql.query(
      "SELECT 1 FROM chat_state_subscriptions WHERE thread_id = $1",
      [this.#threadId(threadId)]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.#ensureConnected();
    const token = randomUUID();
    const result = await this.sql.query<LockRow>(
      `INSERT INTO chat_state_locks (thread_id, token, expires_at)
       VALUES ($1, $2, now() + ($3::bigint * interval '1 millisecond'))
       ON CONFLICT (thread_id) DO UPDATE
         SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
         WHERE chat_state_locks.expires_at <= now()
       RETURNING token, EXTRACT(EPOCH FROM expires_at) * 1000 AS "expiresAt"`,
      [this.#threadId(threadId), token, ttlMs]
    );
    const row = result.rows[0];
    return row
      ? { threadId, token: row.token, expiresAt: Number(row.expiresAt) }
      : null;
  }

  async forceReleaseLock(threadId: string) {
    this.#ensureConnected();
    await this.sql.query("DELETE FROM chat_state_locks WHERE thread_id = $1", [
      this.#threadId(threadId),
    ]);
  }

  async releaseLock(lock: Lock) {
    this.#ensureConnected();
    await this.sql.query(
      "DELETE FROM chat_state_locks WHERE thread_id = $1 AND token = $2",
      [this.#threadId(lock.threadId), lock.token]
    );
  }

  async extendLock(lock: Lock, ttlMs: number) {
    this.#ensureConnected();
    const result = await this.sql.query(
      `UPDATE chat_state_locks
       SET expires_at = now() + ($3::bigint * interval '1 millisecond')
       WHERE thread_id = $1 AND token = $2 AND expires_at > now()`,
      [this.#threadId(lock.threadId), lock.token, ttlMs]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // The Chat SDK's StateAdapter interface deliberately delegates the stored
  // value shape to its caller. Postgres only returns JSON here, so this is the
  // trust boundary for the SDK's own values.
  /* oxlint-disable typescript/no-unnecessary-type-parameters, typescript/no-unsafe-type-assertion */
  async get<T = unknown>(key: string): Promise<T | null> {
    this.#ensureConnected();
    const result = await this.sql.query<StateRow>(
      `SELECT value FROM chat_state_values
       WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [this.#key(key)]
    );
    const value = result.rows[0]?.value;
    return value === undefined ? null : (value as T);
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number) {
    this.#ensureConnected();
    await this.sql.query(
      `INSERT INTO chat_state_values (key, value, expires_at)
       VALUES (
         $1,
         $2::jsonb,
         CASE WHEN $3::bigint IS NULL THEN NULL
              ELSE now() + ($3::bigint * interval '1 millisecond') END
       )
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [this.#key(key), JSON.stringify(value), ttlMs ?? null]
    );
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number) {
    this.#ensureConnected();
    const result = await this.sql.query(
      `INSERT INTO chat_state_values (key, value, expires_at)
       VALUES (
         $1,
         $2::jsonb,
         CASE WHEN $3::bigint IS NULL THEN NULL
              ELSE now() + ($3::bigint * interval '1 millisecond') END
       )
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
         WHERE chat_state_values.expires_at IS NOT NULL
           AND chat_state_values.expires_at <= now()
       RETURNING key`,
      [this.#key(key), JSON.stringify(value), ttlMs ?? null]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async delete(key: string) {
    this.#ensureConnected();
    await this.sql.query("DELETE FROM chat_state_values WHERE key = $1", [
      this.#key(key),
    ]);
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number }
  ) {
    this.#ensureConnected();
    await this.#transaction(async (client) => {
      const current = await client.query<StateRow>(
        "SELECT value FROM chat_state_values WHERE key = $1 FOR UPDATE",
        [this.#key(key)]
      );
      // JSON arrays are the only list representation the Chat SDK writes.
      // `Array.from` copies it before appending so the cached row stays pure.
      // oxlint-disable-next-line typescript/no-unsafe-assignment
      const values: unknown[] = Array.isArray(current.rows[0]?.value)
        ? Array.from(current.rows[0].value)
        : [];
      values.push(value);
      if (
        options?.maxLength !== undefined &&
        values.length > options.maxLength
      ) {
        values.splice(0, values.length - options.maxLength);
      }
      await client.query(
        `INSERT INTO chat_state_values (key, value, expires_at)
         VALUES (
           $1,
           $2::jsonb,
           CASE WHEN $3::bigint IS NULL THEN NULL
                ELSE now() + ($3::bigint * interval '1 millisecond') END
         )
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [this.#key(key), JSON.stringify(values), options?.ttlMs ?? null]
      );
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const value = await this.get(key);
    return Array.isArray(value) ? (value as T[]) : [];
  }
  /* oxlint-enable typescript/no-unnecessary-type-parameters, typescript/no-unsafe-type-assertion */

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number) {
    this.#ensureConnected();
    return this.#transaction(async (client) => {
      // Serialize queue writes for this provider thread without holding a
      // global lock. The queue API is only used for overlap handling.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `chat-state-queue:${this.#threadId(threadId)}`,
      ]);
      await client.query(
        "INSERT INTO chat_state_queue (thread_id, entry) VALUES ($1, $2::jsonb)",
        [this.#threadId(threadId), JSON.stringify(entry)]
      );
      await client.query(
        `DELETE FROM chat_state_queue
         WHERE sequence IN (
           SELECT sequence FROM chat_state_queue
           WHERE thread_id = $1
           ORDER BY sequence DESC OFFSET $2
         )`,
        [this.#threadId(threadId), maxSize]
      );
      const depth = await client.query<{ count: string }>(
        "SELECT count(*) FROM chat_state_queue WHERE thread_id = $1",
        [this.#threadId(threadId)]
      );
      return Number(depth.rows[0]?.count ?? 0);
    });
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    this.#ensureConnected();
    const result = await this.sql.query<QueueRow>(
      `DELETE FROM chat_state_queue
       WHERE sequence = (
         SELECT sequence FROM chat_state_queue
         WHERE thread_id = $1
         ORDER BY sequence
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING entry`,
      [this.#threadId(threadId)]
    );
    return result.rows[0]?.entry ?? null;
  }

  async queueDepth(threadId: string) {
    this.#ensureConnected();
    const result = await this.sql.query<{ count: string }>(
      "SELECT count(*) FROM chat_state_queue WHERE thread_id = $1",
      [this.#threadId(threadId)]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async #transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.sql.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  #ensureConnected() {
    if (!this.#connected) {
      throw new Error(
        "PostgresStateAdapter is not connected. Call connect() first."
      );
    }
  }

  #key(key: string) {
    return this.namespace ? `${this.namespace}:${key}` : key;
  }

  #threadId(threadId: string) {
    return this.#key(threadId);
  }
}

export function createPostgresState(namespace?: string) {
  return new PostgresStateAdapter(pool, namespace);
}
