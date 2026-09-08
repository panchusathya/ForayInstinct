/**
 * One promise for concurrent callers. While a run is in flight every further
 * `run` returns that same promise instead of starting another; once it
 * settles, the next `run` starts fresh. Two sends that raced before a chat
 * session existed each created one, and the candidate's first message and
 * their correction landed in different conversations.
 */
export function singleFlight<T>() {
  let inFlight: Promise<T> | undefined;
  return {
    get pending() {
      return inFlight;
    },
    run(factory: () => Promise<T>): Promise<T> {
      if (inFlight) return inFlight;
      const started = factory().finally(() => {
        if (inFlight === started) inFlight = undefined;
      });
      inFlight = started;
      return started;
    },
  };
}
