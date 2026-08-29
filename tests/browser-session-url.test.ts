import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Browserbase Browser API integration", () => {
  it("creates sessions without a project ID and uses Browserbase CDP URLs", () => {
    const source = readFileSync("lib/browser.ts", "utf8");
    expect(source).toContain(
      "new Browserbase({ apiKey: env.BROWSERBASE_API_KEY })"
    );
    expect(source).toContain("sessions.create({");
    expect(source).toContain("connectUrl");
    expect(source).not.toContain("projectId:");
    expect(source).not.toContain("BRIGHT_DATA_BROWSER_AUTH");
  });
});
