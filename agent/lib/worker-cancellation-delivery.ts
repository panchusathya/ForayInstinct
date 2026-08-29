import { and, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { chatStateValues, db } from "@/db";

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
  const expiresAt = new Date(Date.now() + cancellationTtlMs);
  await db
    .insert(chatStateValues)
    .values({ expiresAt, key, value: { taskId } })
    .onConflictDoUpdate({
      target: chatStateValues.key,
      set: { expiresAt, value: { taskId } },
    });
}

export async function consumeWorkerCancellationTurn(
  sessionId: string,
  turnId: string
) {
  const key = turnKey(sessionId, turnId);
  const rows = await db
    .select({ value: chatStateValues.value })
    .from(chatStateValues)
    .where(
      and(
        eq(chatStateValues.key, key),
        or(
          isNull(chatStateValues.expiresAt),
          gt(chatStateValues.expiresAt, new Date())
        )
      )
    )
    .limit(1);
  await db.delete(chatStateValues).where(eq(chatStateValues.key, key));
  const parsed = cancellationValueSchema.safeParse(rows[0]?.value);
  return parsed.success ? parsed.data.taskId : undefined;
}

export async function clearWorkerCancellationTurn(
  sessionId: string,
  turnId: string
) {
  await db
    .delete(chatStateValues)
    .where(eq(chatStateValues.key, turnKey(sessionId, turnId)));
}

function turnKey(sessionId: string, turnId: string) {
  return `worker-cancel:${sessionId}:${turnId}`;
}

const cancellationValueSchema = z.object({
  taskId: z.string().min(1),
});
