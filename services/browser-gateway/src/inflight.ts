import { gatewayError } from "./errors.ts";

/** Lets a caller hand back the promise whose settling frees the key. */
export type TrackSettled = (settled: Promise<void>) => void;

/**
 * One Playwright script per session at a time.
 *
 * A script that outruns its budget is answered with a timeout, but the
 * function itself keeps driving the page. A caller that then retries, as the
 * runner does after a refused submit, had two copies of the same script
 * clicking at once. The guard holds the session's key until the script the
 * caller tracked has really settled, not merely until its answer went back,
 * and refuses a second script with 409 while it does.
 */
export class InflightGuard {
  private readonly running = new Map<string, Promise<void>>();

  isRunning(key: string) {
    return this.running.has(key);
  }

  async run<T>(
    key: string,
    work: (track: TrackSettled) => Promise<T>
  ): Promise<T> {
    if (this.running.has(key)) {
      throw gatewayError(
        409,
        "execution_in_flight",
        "A Playwright script is still running in this session; wait for it to finish before sending another."
      );
    }
    let tracked: Promise<void> | undefined;
    const track: TrackSettled = (settled) => {
      tracked = settled.then(
        () => undefined,
        () => undefined
      );
    };
    // Declared before the executor runs: the executor assigns it synchronously,
    // and a `let` declared afterwards is still in its temporal dead zone, so
    // the assignment threw, the placeholder became a rejected promise nobody
    // awaited, and Node's unhandled-rejection default killed the gateway on
    // the first script of every session.
    let release: () => void = () => undefined;
    const placeholder = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.running.set(key, placeholder);
    try {
      return await work(track);
    } finally {
      // The answer is out; the key stays taken until the script is done.
      const settled = tracked ?? Promise.resolve();
      this.running.set(key, settled);
      void (async () => {
        await settled;
        if (this.running.get(key) === settled) this.running.delete(key);
      })();
      release();
    }
  }
}
