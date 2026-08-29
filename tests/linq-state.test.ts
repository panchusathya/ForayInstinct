/* oxlint-disable typescript/no-unsafe-type-assertion, vitest/require-mock-type-parameters, typescript/unbound-method -- The query fake only implements Pool.query. */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PostgresStateAdapter } from "../lib/linq-state";

describe("Postgres Linq state adapter", () => {
  it("is wired through chatSdkChannel rather than linqChannel", () => {
    const source = readFileSync("agent/channels/linq-v2.ts", "utf8");
    expect(source).toContain("chatSdkChannel(");
    expect(source).toContain("createPostgresState()");
    expect(source).not.toMatch(/linqChannel\(/u);
  });

  it("inserts a subscription and reports it as subscribed", async () => {
    const sql = fakeSql([{ rowCount: 1, rows: [{}] }]);
    const adapter = new PostgresStateAdapter(sql as never);
    await adapter.connect();
    await adapter.subscribe("linq:dm:chat-1");

    expect(sql.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO chat_state_subscriptions"),
      ["linq:dm:chat-1"]
    );
  });

  it("acquires a lock only when the previous lock has expired", async () => {
    const sql = fakeSql([
      { rowCount: 1, rows: [{}] },
      {
        rowCount: 1,
        rows: [{ expiresAt: Date.now() + 1_000, token: "lock-token" }],
      },
      { rowCount: 0, rows: [] },
    ]);
    const adapter = new PostgresStateAdapter(sql as never);
    await adapter.connect();

    const lock = await adapter.acquireLock("linq:dm:chat-1", 5_000);
    expect(lock).toMatchObject({
      threadId: "linq:dm:chat-1",
      token: "lock-token",
    });

    const denied = await adapter.acquireLock("linq:dm:chat-1", 5_000);
    expect(denied).toBeNull();
  });

  it("round-trips JSON values", async () => {
    const sql = fakeSql([
      { rowCount: 1, rows: [{}] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [{ value: { agentId: "ag_worker:1" } }] },
    ]);
    const adapter = new PostgresStateAdapter(sql as never);
    await adapter.connect();
    await adapter.set("thread:1", { agentId: "ag_worker:1" });
    await expect(adapter.get("thread:1")).resolves.toEqual({
      agentId: "ag_worker:1",
    });
  });
});

function fakeSql(responses: { rowCount: number; rows: unknown[] }[]) {
  const query = vi.fn(
    async () => responses.shift() ?? { rowCount: 0, rows: [] }
  );
  return { query };
}
