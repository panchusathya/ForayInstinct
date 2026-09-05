import { z } from "zod";
import { ensureScope } from "@/db/services/scope";
import type { AccessScope } from "@/lib/access-scope";
import {
  deleteSecret,
  readSecret,
  writeSecret,
} from "@/lib/manager/server/secret-store";

const answersSchema = z.record(z.string(), z.string());
const namespace = "application-answers";

/**
 * One run's answers, by the question label the runner asked.
 *
 * A browser can die between two rounds (Brightdata dropped one twelve minutes
 * in), and the only way on is a fresh browser and the form from the top.
 * Without this the candidate answered "Have you worked at DoorDash?" on
 * every restart. The answers are personal, so they live encrypted with the
 * other per-workspace values, and they are forgotten when the run ends.
 */
export async function readRunAnswers(
  scope: AccessScope,
  executionId: string
): Promise<Record<string, string>> {
  await ensureScope(scope);
  const raw = await readSecret({ id: executionId, namespace, scope });
  if (raw === undefined) return {};
  const parsed = answersSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : {};
}

export async function rememberRunAnswers(
  scope: AccessScope,
  executionId: string,
  answered: Record<string, string>
) {
  const kept = Object.fromEntries(
    Object.entries(answered).filter(([, value]) => value.trim() !== "")
  );
  if (Object.keys(kept).length === 0) return;
  const merged = { ...(await readRunAnswers(scope, executionId)), ...kept };
  await writeSecret({
    id: executionId,
    namespace,
    scope,
    value: JSON.stringify(merged),
  });
}

export async function forgetRunAnswers(
  scope: AccessScope,
  executionId: string
) {
  await ensureScope(scope);
  await deleteSecret({ id: executionId, namespace, scope });
}
