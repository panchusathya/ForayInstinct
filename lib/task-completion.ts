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
