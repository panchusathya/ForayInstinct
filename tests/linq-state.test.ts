import { describe, expect, it, vi } from "vitest";
import { PostgresStateAdapter } from "@/lib/linq-state";

/**
 * The Chat SDK only calls `connect()` inside its webhook handler, but the agent
 * writes thread state on a later turn in a different invocation. The adapter used
 * to throw there, which is why a card mapping written outside a webhook never
 * landed anywhere a reply or a tapback could read it.
 */

function fakePool(rows: unknown[] = []) {
  const query = vi
    .fn<(text: string, values?: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ rowCount: rows.length, rows });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only `query` is exercised.
  return { pool: { query } as never, query };
}

function connectCalls(query: ReturnType<typeof fakePool>["query"]) {
  return query.mock.calls.filter(([text]) => text === "SELECT 1").length;
}

describe("postgres state adapter", () => {
  it("connects on first use instead of demanding an explicit connect", async () => {
    const { pool, query } = fakePool();
    const adapter = new PostgresStateAdapter(pool);

    await expect(adapter.get("thread-state:linq:chat-1")).resolves.toBeNull();
    expect(connectCalls(query)).toBe(1);
  });

  it("connects only once across later calls", async () => {
    const { pool, query } = fakePool();
    const adapter = new PostgresStateAdapter(pool);

    await adapter.get("one");
    await adapter.set("two", { value: 1 });
    await adapter.delete("three");
    expect(connectCalls(query)).toBe(1);
  });

  it("shares a single connect between concurrent callers", async () => {
    const { pool, query } = fakePool();
    const adapter = new PostgresStateAdapter(pool);

    await Promise.all([
      adapter.get("one"),
      adapter.get("two"),
      adapter.get("three"),
    ]);
    expect(connectCalls(query)).toBe(1);
  });

  it("reports whether a claim was won, for tapback idempotency", async () => {
    const won = fakePool([{ key: "claim" }]);
    const lost = fakePool([]);

    await expect(
      new PostgresStateAdapter(won.pool).setIfNotExists("claim", {}, 1_000)
    ).resolves.toBe(true);
    await expect(
      new PostgresStateAdapter(lost.pool).setIfNotExists("claim", {}, 1_000)
    ).resolves.toBe(false);
  });
});
