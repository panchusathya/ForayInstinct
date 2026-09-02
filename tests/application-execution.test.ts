import { describe, expect, it } from "vitest";
import {
  APPLICATION_DISPATCH_GRACE_MS,
  APPLICATION_DUPLICATE_WORKER_WINDOW_MS,
  APPLICATION_WORKER_ACTIVE_MS,
  applicationLeaseExpiresAt,
  executionId,
  isApplicationLeaseExpired,
  isApplicationWorkerDeadlineReached,
  parseApplicationIdentity,
  safeApplyUrl,
  safeErrorCode,
} from "@/lib/application-execution";

describe("application execution tracing", () => {
  it("retains only the explicit identity header and keeps the posting query", () => {
    expect(
      parseApplicationIdentity(
        [
          "Application trace identity: role=Research Scientist; company=Neuralink; apply_url=https://jobs.example/apply/42?gh_jid=99#resume",
          "Candidate profile: private data must not be read by tracing.",
        ].join("\n")
      )
    ).toEqual({
      applyUrl: "https://jobs.example/apply/42?gh_jid=99",
      company: "Neuralink",
      role: "Research Scientist",
    });
    expect(
      parseApplicationIdentity("apply to this role\nemail=private@example.com")
    ).toEqual({ applyUrl: "", company: "", role: "" });
  });

  it("normalizes safe identifiers and errors deterministically", () => {
    expect(safeApplyUrl("https://careers.example/jobs/1?gh_jid=42#top")).toBe(
      "https://careers.example/jobs/1?gh_jid=42"
    );
    expect(
      safeApplyUrl("https://boards.greenhouse.io/acme/jobs/1?gh_jid=aaa")
    ).not.toBe(
      safeApplyUrl("https://boards.greenhouse.io/acme/jobs/1?gh_jid=bbb")
    );
    expect(
      safeErrorCode(
        new Error(
          "Timeout at https://careers.example/?email=private@example.com"
        )
      )
    ).toBe("Timeout at url");
    expect(executionId("root", "call")).toBe(executionId("root", "call"));
  });

  it("blocks a second worker on one posting for longer than a run, not for good", () => {
    expect(APPLICATION_DUPLICATE_WORKER_WINDOW_MS).toBe(2 * 60 * 60_000);
    expect(APPLICATION_DUPLICATE_WORKER_WINDOW_MS).toBeGreaterThan(
      APPLICATION_WORKER_ACTIVE_MS
    );
    expect(APPLICATION_DISPATCH_GRACE_MS).toBe(60_000);
  });

  it("expires an application lease at the 20-minute wall from claim time", () => {
    const claimedAt = new Date(0);
    const expiresAt = applicationLeaseExpiresAt(claimedAt);
    expect(
      isApplicationLeaseExpired(expiresAt, APPLICATION_WORKER_ACTIVE_MS - 1)
    ).toBe(false);
    expect(
      isApplicationLeaseExpired(expiresAt, APPLICATION_WORKER_ACTIVE_MS)
    ).toBe(true);
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
