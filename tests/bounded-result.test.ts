import { describe, expect, it } from "vitest";
import {
  boundResultText,
  playwrightErrorMaxChars,
  playwrightResultMaxChars,
} from "@/agent/subagents/worker/lib/bounded-result";

describe("bounded Playwright results", () => {
  it("returns a value that fits unchanged, whatever its type", () => {
    const result = { fields: ["name", "email"], url: "https://jobs.example" };
    expect(boundResultText(result, playwrightResultMaxChars)).toBe(result);
    expect(boundResultText("ok", playwrightResultMaxChars)).toBe("ok");
    expect(
      boundResultText(undefined, playwrightResultMaxChars)
    ).toBeUndefined();
    expect(boundResultText(null, playwrightResultMaxChars)).toBeNull();
  });

  it("slices an oversized string and says how much was dropped", () => {
    const html = "<div>".repeat(2_000);
    const bounded = boundResultText(html, playwrightResultMaxChars);

    expect(typeof bounded).toBe("string");
    expect(
      String(bounded).startsWith(html.slice(0, playwrightResultMaxChars))
    ).toBe(true);
    expect(bounded).toContain(`truncated: ${String(html.length)} characters`);
    expect(bounded).toContain(`${String(playwrightResultMaxChars)} shown`);
    expect(String(bounded).length).toBeLessThan(playwrightResultMaxChars + 300);
  });

  it("serializes an oversized structure before slicing it", () => {
    const nodes = Array.from({ length: 500 }, (_, index) => ({
      index,
      text: `option ${String(index)}`,
    }));
    const bounded = boundResultText(nodes, playwrightResultMaxChars);

    expect(typeof bounded).toBe("string");
    expect(bounded).toContain('{"index":0,"text":"option 0"}');
    expect(bounded).toContain("not page HTML or full element lists");
  });

  it("caps error text more tightly than results", () => {
    const error = "x".repeat(5_000);
    expect(playwrightErrorMaxChars).toBeLessThan(playwrightResultMaxChars);
    expect(
      String(boundResultText(error, playwrightErrorMaxChars)).startsWith(
        "x".repeat(playwrightErrorMaxChars)
      )
    ).toBe(true);
    expect(boundResultText(error, playwrightErrorMaxChars)).not.toContain(
      "x".repeat(playwrightErrorMaxChars + 1)
    );
  });
});
