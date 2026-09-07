import { describe, expect, it } from "vitest";
import { InflightGuard } from "../src/inflight.ts";

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("one script per session at a time", () => {
  it("refuses a second script while the first is still running", async () => {
    const guard = new InflightGuard();
    const first = deferred();
    const running = guard.run("s1", async () => {
      await first.promise;
      return "one";
    });
    await expect(guard.run("s1", async () => "two")).rejects.toMatchObject({
      status: 409,
      body: { error: { code: "execution_in_flight" } },
    });
    first.resolve();
    await expect(running).resolves.toBe("one");
    await expect(guard.run("s1", async () => "three")).resolves.toBe("three");
  });

  it("keeps the key until a tracked script settles, not merely until its answer went back", async () => {
    // A timed-out script answers early and keeps driving the page. The retry
    // the runner sends next must wait for it, or two submits click at once.
    const guard = new InflightGuard();
    const orphan = deferred();
    const answered = await guard.run("s1", async (track) => {
      track(orphan.promise);
      return "timed out";
    });
    expect(answered).toBe("timed out");
    expect(guard.isRunning("s1")).toBe(true);
    await expect(guard.run("s1", async () => "retry")).rejects.toMatchObject({
      status: 409,
    });
    orphan.resolve();
    await orphan.promise;
    await new Promise((done) => setTimeout(done, 0));
    expect(guard.isRunning("s1")).toBe(false);
    await expect(guard.run("s1", async () => "retry")).resolves.toBe("retry");
  });

  it("lets different sessions run side by side", async () => {
    const guard = new InflightGuard();
    const hold = deferred();
    const one = guard.run("s1", async () => {
      await hold.promise;
      return 1;
    });
    await expect(guard.run("s2", async () => 2)).resolves.toBe(2);
    hold.resolve();
    await expect(one).resolves.toBe(1);
  });
});
