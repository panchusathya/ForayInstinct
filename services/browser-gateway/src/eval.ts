// @boundaries-ignore shared wire contract lives in the app package (lib/browser/contract.ts)
import type { PlaywrightResponse } from "../../../lib/browser/contract.ts";

export interface EvalScope {
  browser: unknown;
  context: unknown;
  page: unknown;
}

/**
 * The incoming code is a raw statement block written for Kernel's remote
 * executor: it contains top-level `await` and `return` statements and expects
 * `browser`/`page` in scope. Wrapping it in an AsyncFunction body reproduces
 * that environment exactly.
 */
type AsyncFunctionConstructor = new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript's lib does not expose the AsyncFunction constructor; reading it off an async function literal is the standard way to obtain it.
const AsyncFunction = (async () => undefined)
  .constructor as AsyncFunctionConstructor;

export async function runPlaywrightCode(
  scope: EvalScope,
  code: string,
  timeoutSec: number
): Promise<PlaywrightResponse> {
  let compiled: (...values: unknown[]) => Promise<unknown>;
  try {
    compiled = new AsyncFunction("browser", "page", "context", code);
  } catch (error) {
    return { error: describeError(error), success: false };
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Execution timed out after ${String(timeoutSec)}s`));
    }, timeoutSec * 1_000);
  });
  try {
    const result = await Promise.race([
      compiled(scope.browser, scope.page, scope.context),
      timeout,
    ]);
    return result === undefined
      ? { success: true }
      : { result: serialize(result), success: true };
  } catch (error) {
    return { error: describeError(error), success: false };
  } finally {
    clearTimeout(timer);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/** The envelope crosses the wire as JSON, so the result must survive it. */
function serialize(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}
