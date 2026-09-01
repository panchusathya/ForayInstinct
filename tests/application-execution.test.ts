import { describe, expect, it } from "vitest";
import {
  APPLICATION_WORKER_ACTIVE_MS,
  executionId,
  isApplicationWorkerDeadlineReached,
  parseApplicationIdentity,
  safeApplyUrl,
  safeErrorCode,
} from "@/lib/application-execution";

describe("application execution tracing", () => {
  it("retains only the explicit identity header and strips URL secrets", () => {
    expect(
      parseApplicationIdentity(
        [
          "Application trace identity: role=Research Scientist; company=Neuralink; apply_url=https://jobs.example/apply/42?token=secret#resume",
          "Candidate profile: private data must not be read by tracing.",
        ].join("\n")
      )
    ).toEqual({
      applyUrl: "https://jobs.example/apply/42",
      company: "Neuralink",
      role: "Research Scientist",
    });
    expect(
      parseApplicationIdentity("apply to this role\nemail=private@example.com")
    ).toEqual({ applyUrl: "", company: "", role: "" });
  });

  it("normalizes safe identifiers and errors deterministically", () => {
    expect(
      safeApplyUrl("https://careers.example/jobs/1?resume=private#top")
    ).toBe("https://careers.example/jobs/1");
    expect(
      safeErrorCode(
        new Error(
          "Timeout at https://careers.example/?email=private@example.com"
        )
      )
    ).toBe("Timeout at url");
    expect(executionId("root", "call")).toBe(executionId("root", "call"));
  });

  it("guards browser work at the active-worker deadline", () => {
    const startedAt = new Date(0).toISOString();
    expect(
      isApplicationWorkerDeadlineReached(
        startedAt,
        APPLICATION_WORKER_ACTIVE_MS - 1
      )
    ).toBe(false);
    expect(
      isApplicationWorkerDeadlineReached(
        startedAt,
        APPLICATION_WORKER_ACTIVE_MS
      )
    ).toBe(true);
  });
});
