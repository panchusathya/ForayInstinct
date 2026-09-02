import { z } from "zod";

const successStatuses = new Set([
  "complete",
  "completed",
  "ok",
  "succeeded",
  "success",
]);

export function normalizeTaskStatus(status: string): "failure" | "success" {
  return successStatuses.has(status.trim().toLowerCase())
    ? "success"
    : "failure";
}

/**
 * Worker completion contract. Keep this lenient: Eve validates `final_output`
 * against the JSON Schema of this object, and a strict enum or
 * `additionalProperties: false` is what turned a finished browser run into a
 * formatting error the coordinator then retried.
 */
export const taskCompletionSchema = z
  .object({
    message: z.string().trim().min(1),
    status: z.string().trim().min(1),
  })
  .loose();

export interface TaskCompletion {
  message: string;
  status: "failure" | "success";
}

export function parseTaskCompletion(
  output: unknown
): TaskCompletion | undefined {
  const direct = taskCompletionSchema.safeParse(output);
  if (direct.success) {
    return {
      message: direct.data.message,
      status: normalizeTaskStatus(direct.data.status),
    };
  }
  if (typeof output !== "string") return undefined;

  try {
    const parsed = taskCompletionSchema.safeParse(JSON.parse(output));
    if (!parsed.success) return undefined;
    return {
      message: parsed.data.message,
      status: normalizeTaskStatus(parsed.data.status),
    };
  } catch {
    return undefined;
  }
}

/**
 * The worker's blocker vocabulary, owned here rather than restated in five
 * prompts. Only `Needs submission approval:` was ever matched in code; every
 * other blocker lived in the instructions alone, so nothing verified that the
 * worker had actually reported one before the coordinator acted on it. An
 * unavailable posting had no category at all, and a failed apply against a
 * taken-down role was narrated to a candidate as an email OTP problem.
 *
 * `already_in_progress` is the structured duplicate-dispatch status. The
 * worker-facing error still starts with `Needs existing worker:` so existing
 * instructions keep matching.
 */
export const alreadyInProgressStatus = "already_in_progress";

const workerBlockers = [
  ["alreadyInProgress", "already_in_progress:"],
  ["emailOtp", "Needs email OTP:"],
  ["existingWorker", "Needs existing worker:"],
  ["postingUnavailable", "Needs posting unavailable:"],
  ["submissionApproval", "Needs submission approval:"],
  ["userInput", "Needs user input:"],
  ["vaultSetup", "Needs vault setup:"],
] as const;

type WorkerBlocker = (typeof workerBlockers)[number][0];

/** The exact prefix a worker must put on a blocker message of this kind. */
export function workerBlockerPrefix(kind: WorkerBlocker) {
  const entry = workerBlockers.find(([name]) => name === kind);
  if (!entry) throw new Error(`Unknown worker blocker: ${kind}`);
  return entry[1];
}

/** The blocker the worker actually reported, or undefined for anything else. */
export function blockerKind(message: string): WorkerBlocker | undefined {
  const trimmed = message.trimStart().toLowerCase();
  return workerBlockers.find(([, prefix]) =>
    trimmed.startsWith(prefix.toLowerCase())
  )?.[0];
}
