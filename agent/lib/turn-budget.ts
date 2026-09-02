import { pool } from "@/db";
import { env } from "@/lib/env";
import { eveSessionClient } from "@/lib/eve-client";

/**
 * Per-turn runaway guard for the coordinator. A lifetime session cap trips on
 * healthy long-lived chat threads and starves the workers dispatched near the
 * end, so the coordinator is uncapped for life and bounded per turn instead:
 * one turn that keeps calling the model past these numbers is a loop, not a
 * conversation, and gets cancelled through eve's ordinary cancellation path.
 * A normal coordinator turn is one to six steps.
 */
export const TURN_STEP_LIMIT = 30;
export const TURN_INPUT_TOKEN_LIMIT = 600_000;

interface TurnUsage {
  /** Provider-reported input tokens by step index; a retried step overwrites. */
  steps: Record<string, number>;
}

export interface TurnTotals {
  inputTokens: number;
  steps: number;
}

const runtime = globalThis as typeof globalThis & {
  openInstinctTurnUsage?: Map<string, TurnUsage>;
};
const turnUsage = (runtime.openInstinctTurnUsage ??= new Map<
  string,
  TurnUsage
>());

const turnUsageTtlMs = 60 * 60 * 1000;

/** Records one completed step and returns the turn's totals so far. */
export async function recordTurnStep(input: {
  inputTokens: number;
  sessionId: string;
  stepIndex: number;
  turnId: string;
}): Promise<TurnTotals> {
  const key = turnKey(input.sessionId, input.turnId);
  const usage = turnUsage.get(key) ?? { steps: {} };
  usage.steps[String(input.stepIndex)] = input.inputTokens;
  turnUsage.set(key, usage);
  const persisted = await persistStep(key, input.stepIndex, input.inputTokens);
  return totals(persisted ?? usage);
}

export async function clearTurnBudget(sessionId: string, turnId: string) {
  const key = turnKey(sessionId, turnId);
  turnUsage.delete(key);
  await deletePersisted(key);
}

export function turnBudgetExceeded(turn: TurnTotals) {
  if (turn.steps > TURN_STEP_LIMIT) return "steps" as const;
  if (turn.inputTokens > TURN_INPUT_TOKEN_LIMIT) return "input_tokens" as const;
  return undefined;
}

/**
 * Cancels the turn through eve's public session API. The cancel command is
 * queued on the session inbox and settles as `turn.cancelled`, so the session
 * stays resumable and the next message starts a clean turn.
 */
export async function cancelRunawayTurn(input: {
  reason: "input_tokens" | "steps";
  sessionId: string;
  totals: TurnTotals;
  turnId: string;
}) {
  console.error("[turn-budget] cancelling runaway turn", {
    input_tokens: input.totals.inputTokens,
    reason: input.reason,
    session_id: input.sessionId,
    steps: input.totals.steps,
    turn_id: input.turnId,
  });
  await eveSessionClient()
    .sessions.attach(input.sessionId)
    .cancel({ turnId: input.turnId });
}

function totals(usage: TurnUsage): TurnTotals {
  const values = Object.values(usage.steps);
  return {
    inputTokens: values.reduce((sum, tokens) => sum + tokens, 0),
    steps: values.length,
  };
}

function turnKey(sessionId: string, turnId: string) {
  return `${sessionId}:${turnId}`;
}

function persistenceKey(turn: string) {
  return `turn-budget:${turn}`;
}

function persistDurably() {
  return env.NODE_ENV !== "test";
}

/**
 * Steps of one turn can run on different instances, so the durable row is the
 * accumulator of record: one atomic jsonb merge per step, returning the merged
 * value, so no read-modify-write race can drop a step.
 */
async function persistStep(
  turn: string,
  stepIndex: number,
  inputTokens: number
) {
  if (!persistDurably()) return;
  try {
    const result = await pool.query<{ value: unknown }>(
      `INSERT INTO chat_state_values (key, value, expires_at)
       VALUES (
         $1,
         jsonb_build_object('steps', jsonb_build_object($2::text, $3::bigint)),
         now() + ($4::bigint * interval '1 millisecond')
       )
       ON CONFLICT (key) DO UPDATE
         SET value = jsonb_build_object(
               'steps',
               coalesce(chat_state_values.value -> 'steps', '{}'::jsonb)
                 || jsonb_build_object($2::text, $3::bigint)
             ),
             expires_at = EXCLUDED.expires_at
       RETURNING value`,
      [persistenceKey(turn), String(stepIndex), inputTokens, turnUsageTtlMs]
    );
    return parseTurnUsage(result.rows[0]?.value);
  } catch (error: unknown) {
    console.error("[turn-budget] persist failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return;
  }
}

async function deletePersisted(turn: string) {
  if (!persistDurably()) return;
  try {
    await pool.query("DELETE FROM chat_state_values WHERE key = $1", [
      persistenceKey(turn),
    ]);
  } catch (error: unknown) {
    console.error("[turn-budget] delete failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

function parseTurnUsage(value: unknown): TurnUsage | undefined {
  if (typeof value !== "object" || value === null) return;
  const steps = (value as { steps?: unknown }).steps;
  if (typeof steps !== "object" || steps === null) return;
  const parsed: Record<string, number> = {};
  for (const [index, tokens] of Object.entries(steps)) {
    const count = typeof tokens === "number" ? tokens : Number(tokens);
    if (Number.isFinite(count)) parsed[index] = count;
  }
  return { steps: parsed };
}
