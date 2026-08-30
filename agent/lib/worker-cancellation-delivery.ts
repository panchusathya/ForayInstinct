import { pool } from "@/db";

const runtime = globalThis as typeof globalThis & {
  openInstinctWorkerCancellationTurns?: Map<string, string>;
};
const cancellationTurns = (runtime.openInstinctWorkerCancellationTurns ??=
  new Map<string, string>());

const cancellationTtlMs = 60 * 60 * 1000;

export async function recordWorkerCancellationTurn(
  sessionId: string,
  turnId: string,
  message: string
) {
  const taskId = /^Background task (\S+) \(worker\) is cancelled\.$/u.exec(
    message
  )?.[1];
  if (!taskId) return;
  const key = turnKey(sessionId, turnId);
  cancellationTurns.set(key, taskId);
  await persistCancellation(key, taskId);
}

export async function consumeWorkerCancellationTurn(
  sessionId: string,
  turnId: string
) {
  const key = turnKey(sessionId, turnId);
  const fromMemory = cancellationTurns.get(key);
  cancellationTurns.delete(key);
  if (fromMemory) {
    await deletePersistedCancellation(key);
    return fromMemory;
  }
  return readAndDeletePersistedCancellation(key);
}

export async function clearWorkerCancellationTurn(
  sessionId: string,
  turnId: string
) {
  const key = turnKey(sessionId, turnId);
  cancellationTurns.delete(key);
  await deletePersistedCancellation(key);
}

function turnKey(sessionId: string, turnId: string) {
  return `${sessionId}:${turnId}`;
}

function persistenceKey(turn: string) {
  return `worker-cancellation:${turn}`;
}

function persistDurably() {
  return process.env.NODE_ENV !== "test";
}

async function persistCancellation(turn: string, taskId: string) {
  if (!persistDurably()) return;
  try {
    await pool.query(
      `INSERT INTO chat_state_values (key, value, expires_at)
       VALUES (
         $1,
         $2::jsonb,
         now() + ($3::bigint * interval '1 millisecond')
       )
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [persistenceKey(turn), JSON.stringify(taskId), cancellationTtlMs]
    );
  } catch (error: unknown) {
    console.error("[worker-cancellation] persist failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

async function deletePersistedCancellation(turn: string) {
  if (!persistDurably()) return;
  try {
    await pool.query("DELETE FROM chat_state_values WHERE key = $1", [
      persistenceKey(turn),
    ]);
  } catch (error: unknown) {
    console.error("[worker-cancellation] delete failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

async function readAndDeletePersistedCancellation(turn: string) {
  if (!persistDurably()) return;
  try {
    const result = await pool.query<{ value: unknown }>(
      `DELETE FROM chat_state_values
       WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())
       RETURNING value`,
      [persistenceKey(turn)]
    );
    const value = result.rows[0]?.value;
    return typeof value === "string" ? value : undefined;
  } catch (error: unknown) {
    console.error("[worker-cancellation] consume failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return;
  }
}
