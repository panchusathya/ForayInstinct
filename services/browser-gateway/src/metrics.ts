import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * Why this exists.
 *
 * `/health` is a handler that reads a map size and returns. Polled every ten
 * seconds from outside, it answered in 0.32s while the gateway was idle and
 * took 3-12 seconds, or timed out outright, while a browser session was
 * live: 7 slow answers and 4 timeouts in 27 probes with a session, against 1
 * slow and none in 14 without one. Latency on that route is not the route. It
 * is the process failing to get back to its own event loop.
 *
 * What it cannot say from outside is why. A blocking call in the request
 * path, garbage collection on a heap under pressure, and a shared-CPU
 * container being throttled all look identical through a socket, and they
 * have different fixes. Measuring the delay in-process separates them: lag
 * with a flat heap points at the platform or a blocking call, lag that tracks
 * heap growth points at collection.
 *
 * Cheap enough to leave on: a libuv timer at 20ms resolution, no allocation
 * per sample.
 */
const resolutionMs = 20;

const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
histogram.enable();

// `mean` is NaN until the first sample lands, and NaN crosses JSON as null.
// A health route that reports a null is one someone has to squint at, so an
// empty window reads as zero lag, which is what it means.
const toMs = (nanoseconds: number) =>
  Number.isFinite(nanoseconds) ? Math.round((nanoseconds / 1e6) * 10) / 10 : 0;

const toMb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * Reading resets the histogram, so each poll describes the window since the
 * previous one rather than diluting a stall into an average since boot. A
 * single poller is assumed; a second one racing it only splits the window.
 */
export function readEventLoopDelay() {
  const snapshot = {
    max_ms: toMs(histogram.max),
    mean_ms: toMs(histogram.mean),
    p99_ms: toMs(histogram.percentile(99)),
  };
  histogram.reset();
  return snapshot;
}

export function readMemory() {
  const memory = process.memoryUsage();
  return {
    heap_total_mb: toMb(memory.heapTotal),
    heap_used_mb: toMb(memory.heapUsed),
    rss_mb: toMb(memory.rss),
  };
}
