import { z } from "zod";

export function logWorkerToolError(input: {
  error: unknown;
  sessionId?: string;
  toolName: string;
}) {
  logWorkerRuntimeEvent({
    error: errorMessage(input.error),
    kind: "worker.tool_error",
    sessionId: input.sessionId,
    toolName: input.toolName,
  });
}

export async function withWorkerToolError<T>(
  toolName: string,
  sessionId: string | undefined,
  operate: () => Promise<T>
) {
  try {
    return await operate();
  } catch (error) {
    logWorkerToolError({ error, sessionId, toolName });
    throw error;
  }
}

export function logWorkerRuntimeEvent(payload: Record<string, unknown>) {
  try {
    console.error(
      JSON.stringify({
        ...payload,
        error:
          payload.error ?? payload.message ?? errorFromResult(payload.result),
      })
    );
  } catch {
    // Structured logs must never replace the original failure.
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorFromResult(result: unknown) {
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success) return undefined;
  return errorMessage(
    parsed.data.error ?? parsed.data.message ?? parsed.data.output
  );
}

const resultSchema = z.object({
  error: z.unknown().optional(),
  message: z.unknown().optional(),
  output: z.unknown().optional(),
});
