import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, { taskId: string }>());

vi.mock("@/db", () => {
  const chatStateValues = {
    key: "key",
    value: "value",
    expiresAt: "expiresAt",
  };
  return {
    chatStateValues,
    db: {
      insert() {
        return {
          values(row: { key: string; value: { taskId: string } }) {
            return {
              async onConflictDoUpdate() {
                store.set(row.key, row.value);
              },
            };
          },
        };
      },
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    const key = [...store.keys()][0];
                    const value = key ? store.get(key) : undefined;
                    return Promise.resolve(value ? [{ value }] : []);
                  },
                };
              },
            };
          },
        };
      },
      delete() {
        return {
          async where() {
            store.clear();
          },
        };
      },
    },
  };
});

describe("worker cancellation delivery", () => {
  beforeEach(() => {
    store.clear();
  });

  it("stores and consumes a cancelled worker task id", async () => {
    const { recordWorkerCancellationTurn, consumeWorkerCancellationTurn } =
      await import("../agent/lib/worker-cancellation-delivery");

    await recordWorkerCancellationTurn(
      "session-1",
      "turn-1",
      "Background task task-worker (worker) is cancelled."
    );
    await expect(
      consumeWorkerCancellationTurn("session-1", "turn-1")
    ).resolves.toBe("task-worker");
    await expect(
      consumeWorkerCancellationTurn("session-1", "turn-1")
    ).resolves.toBeUndefined();
  });

  it("ignores unrelated messages", async () => {
    const { recordWorkerCancellationTurn, consumeWorkerCancellationTurn } =
      await import("../agent/lib/worker-cancellation-delivery");

    await recordWorkerCancellationTurn("session-1", "turn-1", "Saved.");
    await expect(
      consumeWorkerCancellationTurn("session-1", "turn-1")
    ).resolves.toBeUndefined();
  });
});
