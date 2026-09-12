import { describe, expect, it } from "vitest";
import { DeadlineError, withDeadline, withDeadlineOr } from "../src/deadline.ts";

describe("withDeadline", () => {
  it("returns the value of work that finishes in time", async () => {
    await expect(withDeadline(Promise.resolve(7), 50, "quick")).resolves.toBe(
      7
    );
  });

  it("rejects with a DeadlineError when work never settles", async () => {
    const never = new Promise<never>(() => undefined);
    const failure = await withDeadline(never, 20, "hung command").catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(DeadlineError);
    expect(failure).toMatchObject({
      message: "hung command did not finish within 20ms",
    });
  });

  it("passes the work's own rejection through", async () => {
    await expect(
      withDeadline(Promise.reject(new Error("boom")), 50, "failing")
    ).rejects.toThrow("boom");
  });

  it("does not leave the losing promise as an unowned rejection", async () => {
    let lateReject: (error: Error) => void = () => undefined;
    const late = new Promise<never>((_, reject) => {
      lateReject = reject;
    });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      await withDeadline(late, 10, "late").catch(() => undefined);
      lateReject(new Error("too late"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

describe("withDeadlineOr", () => {
  it("resolves to the fallback on timeout or failure", async () => {
    const never = new Promise<never>(() => undefined);
    await expect(withDeadlineOr(never, 10, "hung", "fallback")).resolves.toBe(
      "fallback"
    );
    await expect(
      withDeadlineOr(Promise.reject(new Error("x")), 10, "bad", null)
    ).resolves.toBeNull();
  });
});
