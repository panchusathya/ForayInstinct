import { describe, expect, it } from "vitest";
import {
  consumeWorkerCancellationTurn,
  recordWorkerCancellationTurn,
} from "@/agent/lib/worker-cancellation-delivery";

describe("recognising the framework's cancellation notice", () => {
  it("reads the task id out of the wording however the framework puts it", async () => {
    // An exact sentence broke on a trailing newline or a changed verb, and
    // the raw envelope then reached the candidate.
    const variants = [
      "Background task tk_abc (worker) is cancelled.",
      "Background task tk_def (worker) was cancelled",
      "Background task tk_ghi (application-runner) has been canceled.\n",
      "  background task tk_jkl (worker) is cancelled. ",
    ];
    for (const [index, message] of variants.entries()) {
      await recordWorkerCancellationTurn(
        "session",
        `turn-${String(index)}`,
        message
      );
    }
    await expect(
      consumeWorkerCancellationTurn("session", "turn-0")
    ).resolves.toBe("tk_abc");
    await expect(
      consumeWorkerCancellationTurn("session", "turn-1")
    ).resolves.toBe("tk_def");
    await expect(
      consumeWorkerCancellationTurn("session", "turn-2")
    ).resolves.toBe("tk_ghi");
    await expect(
      consumeWorkerCancellationTurn("session", "turn-3")
    ).resolves.toBe("tk_jkl");
  });

  it("records nothing for an ordinary message", async () => {
    await recordWorkerCancellationTurn(
      "session",
      "turn-x",
      "The application was submitted."
    );
    await expect(
      consumeWorkerCancellationTurn("session", "turn-x")
    ).resolves.toBeUndefined();
  });
});
