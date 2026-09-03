import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "@/lib/with-timeout";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

describe("bounding a best-effort step", () => {
  it("returns the work when it settles in time", async () => {
    await expect(
      withTimeout(() => Promise.resolve("done"), 1_000, "fallback")
    ).resolves.toBe("done");
  });

  it("gives up rather than holding the turn", async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(
        () => new Promise<string>(() => undefined),
        5_000,
        "fallback"
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toBe("fallback");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a rejection as the fallback, since every caller carries on", async () => {
    await expect(
      withTimeout(
        () => Promise.reject(new Error("upstream")),
        1_000,
        "fallback"
      )
    ).resolves.toBe("fallback");
  });
});

describe("calls out to JuiceBox", () => {
  const bridge = readFileSync("lib/goforay/bridge.ts", "utf8");

  it("bounds every one of them", () => {
    // An upstream that accepted the connection and then went quiet held the
    // inbound webhook until Vercel killed the function at five minutes, and
    // the candidate's message was dropped with no reply and no retry.
    const fetches = bridge.match(/await fetch\(/gu) ?? [];
    const signals = bridge.match(/signal: AbortSignal\.timeout\(/gu) ?? [];

    expect(fetches.length).toBeGreaterThan(0);
    expect(signals).toHaveLength(fetches.length);
  });

  it("bounds the inbound one the tightest", () => {
    // linkCandidate runs for every text a candidate sends.
    expect(bridge).toContain("const INBOUND_BRIDGE_TIMEOUT_MS = 5_000;");
    expect(bridge).toContain(
      "signal: AbortSignal.timeout(INBOUND_BRIDGE_TIMEOUT_MS)"
    );
  });
});

describe("the Linq inbound path", () => {
  const channel = readFileSync("agent/channels/linq-v2.ts", "utf8");

  it("starts the CRM link without waiting for it", () => {
    // Nothing below it reads the result, so awaiting it only added a way for
    // a slow upstream to lose the candidate's message.
    expect(channel).toContain("void linkCandidate({");
    expect(channel).not.toContain("await linkCandidate(");
  });

  it("bounds every courtesy that runs before a turn", () => {
    // Every call site, not the first: the tapback-to-apply handler runs its
    // own copy of the idle reset inside the reaction webhook.
    for (const step of [
      'bot.getAdapter("linq").markRead(thread.id, message.id)',
      'reactToLinqMessage(thread, message.id, "👍")',
      "rollOverIdleLinqSession(thread)",
    ]) {
      const sites = [...channel.matchAll(new RegExp(escapeRegExp(step), "gu"))];
      expect(sites.length).toBeGreaterThan(0);
      for (const site of sites) {
        const wrapper = channel.lastIndexOf("withTimeout(", site.index);
        expect(wrapper).toBeGreaterThan(-1);
        // Immediately inside the wrapper, not merely somewhere after one.
        expect(site.index - wrapper).toBeLessThan(80);
      }
    }
  });

  it("records each step so a timeout names itself", () => {
    // When the request died at the function limit the log simply stopped,
    // naming nothing. The last step logged is now the one that hung.
    for (const step of [
      '"reply_target"',
      '"prepare"',
      '"review_recovery"',
      '"mark_read"',
      '"rollover"',
      '"send"',
    ]) {
      expect(channel).toContain(`inboundStep(${step}`);
    }
    expect(channel).toContain("duration_ms: Date.now() - startedAt");
  });
});
