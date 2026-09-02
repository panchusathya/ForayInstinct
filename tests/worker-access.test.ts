import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessScopeForUser, type AccessScope } from "@/lib/access-scope";

const mocks = vi.hoisted(() => ({
  assertApplicationLeaseOwner: vi.fn<() => Promise<void>>(),
  assertNoConcurrentApplicationWorker: vi.fn<() => Promise<void>>(),
  claimSession: vi.fn(),
  ensureScope: vi.fn(),
  isSessionOwned:
    vi.fn<(_scope: AccessScope, _sessionId: string) => Promise<boolean>>(),
}));

vi.mock("@/db/services/sessions", () => ({
  claimSession: mocks.claimSession,
  isSessionOwned: mocks.isSessionOwned,
}));
vi.mock("@/db/services/scope", () => ({ ensureScope: mocks.ensureScope }));
vi.mock("@/db/services/application-executions", () => ({
  assertNoConcurrentApplicationWorker:
    mocks.assertNoConcurrentApplicationWorker,
}));
vi.mock("@/db/services/application-leases", () => ({
  assertApplicationLeaseOwner: mocks.assertApplicationLeaseOwner,
}));

import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSessionOwned.mockResolvedValue(true);
});

describe("worker access", () => {
  it("allows an internal child turn only when its worker and root sessions are owned", async () => {
    const principal = principalFor("better-auth:alice");
    await expect(
      requireWorkerScope({
        session: workerSession({ current: null, initiator: principal }),
      })
    ).resolves.toEqual(accessScopeForUser(principal.principalId));

    expect(mocks.isSessionOwned).toHaveBeenCalledTimes(2);
    expect(mocks.isSessionOwned).toHaveBeenNthCalledWith(
      1,
      accessScopeForUser(principal.principalId),
      "worker-session"
    );
    expect(mocks.isSessionOwned).toHaveBeenNthCalledWith(
      2,
      accessScopeForUser(principal.principalId),
      "root-session"
    );
  });

  it("rejects direct use and unowned worker lineage", async () => {
    const principal = principalFor("better-auth:alice");
    const session = workerSession({ current: principal, initiator: principal });

    await expect(
      requireWorkerScope({ session: { ...session, parent: undefined } })
    ).rejects.toThrow("require a delegated worker");

    mocks.isSessionOwned
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    await expect(requireWorkerScope({ session })).rejects.toThrow(
      "does not own this worker session"
    );
  });

  it("claims a just-created delegated worker after verifying its root", async () => {
    const principal = principalFor("better-auth:alice");
    mocks.isSessionOwned
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    await expect(
      requireWorkerScope({
        session: workerSession({ current: null, initiator: principal }),
      })
    ).resolves.toEqual(accessScopeForUser(principal.principalId));

    expect(mocks.claimSession).toHaveBeenCalledWith(
      accessScopeForUser(principal.principalId),
      "worker-session"
    );
  });

  it("relays a duplicate-worker blocker before any browser work", async () => {
    const principal = principalFor("better-auth:alice");
    mocks.assertNoConcurrentApplicationWorker.mockRejectedValueOnce(
      new Error(
        "Needs existing worker: another worker (session worker-0) is already handling https://jobs.example/1."
      )
    );

    await expect(
      requireWorkerScope({
        session: workerSession({ current: null, initiator: principal }),
      })
    ).rejects.toThrow(/^Needs existing worker:/);
    expect(mocks.assertApplicationLeaseOwner).toHaveBeenCalledWith({
      parentCallId: "worker-call",
      rootSessionId: "root-session",
      workerSessionId: "worker-session",
    });
    expect(mocks.assertNoConcurrentApplicationWorker).toHaveBeenCalledWith({
      parentCallId: "worker-call",
      rootSessionId: "root-session",
      workerSessionId: "worker-session",
    });
  });

  it("blocks an overdue or unleased worker before any browser work", async () => {
    const principal = principalFor("better-auth:alice");
    mocks.assertApplicationLeaseOwner.mockRejectedValueOnce(
      new Error("Application worker exceeded the 20-minute safety limit.")
    );
    await expect(
      requireWorkerScope({
        session: workerSession({ current: null, initiator: principal }),
      })
    ).rejects.toThrow("20-minute safety limit");
    expect(mocks.assertNoConcurrentApplicationWorker).not.toHaveBeenCalled();

    mocks.assertApplicationLeaseOwner.mockRejectedValueOnce(
      new Error("Application worker requires an application lease.")
    );
    await expect(
      requireWorkerScope({
        session: workerSession({ current: null, initiator: principal }),
      })
    ).rejects.toThrow("requires an application lease");
  });
});

function principalFor(userId: string) {
  return {
    attributes: { workspaceId: accessScopeForUser(userId).workspaceId },
    authenticator: "test",
    principalId: userId,
    principalType: "user",
  } as const;
}

function workerSession(auth: {
  current: ReturnType<typeof principalFor> | null;
  initiator: ReturnType<typeof principalFor> | null;
}) {
  return {
    auth,
    id: "worker-session",
    parent: {
      callId: "worker-call",
      rootSessionId: "root-session",
      sessionId: "root-session",
      turn: { id: "root-turn", sequence: 0 },
    },
    turn: { id: "worker-turn", sequence: 0 },
  };
}
