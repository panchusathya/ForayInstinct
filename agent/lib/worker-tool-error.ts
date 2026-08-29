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

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorFromResult(result: unknown) {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  return errorMessage(record.error ?? record.message ?? record.output);
}
