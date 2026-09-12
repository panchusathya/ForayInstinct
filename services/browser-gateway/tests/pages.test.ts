import { describe, expect, it } from "vitest";
import { pickCurrentPage } from "../src/pages.ts";

function page(answer: boolean | "hang" | "throw") {
  return {
    answer,
    evaluate: () => {
      if (answer === "hang") return new Promise<boolean>(() => undefined);
      if (answer === "throw") return Promise.reject(new Error("target closed"));
      return Promise.resolve(answer);
    },
  };
}

describe("pickCurrentPage", () => {
  it("prefers the visible page", async () => {
    const hidden = page(false);
    const visible = page(true);
    await expect(pickCurrentPage([hidden, visible, page(false)])).resolves.toBe(
      visible
    );
  });

  it("falls back to the most recent page when none reports visible", async () => {
    const last = page(false);
    await expect(pickCurrentPage([page(false), last])).resolves.toBe(last);
  });

  it("answers within the probe budget when a page never evaluates", async () => {
    // A page mid-unlock on a protected site holds evaluate for as long as the
    // unlock takes. Before this bound, that wait sat in front of every script
    // and its timer, and the request ran to the client's deadline unanswered.
    const hung = page("hang");
    const started = Date.now();
    await expect(pickCurrentPage([hung], 25)).resolves.toBe(hung);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("treats a page whose evaluate throws as not visible", async () => {
    const visible = page(true);
    await expect(pickCurrentPage([page("throw"), visible])).resolves.toBe(
      visible
    );
  });

  it("returns undefined for no pages", async () => {
    await expect(pickCurrentPage([])).resolves.toBeUndefined();
  });
});
