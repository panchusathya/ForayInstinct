import { describe, expect, it } from "vitest";
import { z } from "zod";
import computerAction from "../agent/subagents/worker/tools/computer_action";

describe("computer_action model output", () => {
  it("keeps structured action data when a screenshot is included", () => {
    const output = computerAction.toModelOutput?.({
      data: [{ type: "read_clipboard", text: "pasted-id" }],
      message: "Executed 2 computer actions.",
      mimeType: "image/png",
      screenshotsBase64: ["aaaa"],
    });

    expect(JSON.stringify(output)).toContain("pasted-id");
    expect(JSON.stringify(output)).toContain("image/png");
  });

  it("emits one file part per screenshot in a batch", () => {
    const output = computerAction.toModelOutput?.({
      message: "Executed 3 computer actions.",
      mimeType: "image/png",
      screenshotsBase64: ["aaaa", "bbbb"],
    });

    const serialized = JSON.stringify(output);
    expect(serialized).toContain("aaaa");
    expect(serialized).toContain("bbbb");
  });

  it("caps a batch at twelve actions and two screenshots", () => {
    const schema = computerAction.inputSchema;
    if (!(schema instanceof z.ZodType))
      throw new Error("expected a zod schema");
    const accepts = (actions: { type: string }[]) =>
      schema.safeParse({ actions, session_id: "browser-1" }).success;
    const screenshot = { type: "screenshot" };
    const sleep = { sleep: { duration_ms: 100 }, type: "sleep" };

    expect(
      accepts([
        ...Array.from({ length: 10 }, () => sleep),
        screenshot,
        screenshot,
      ])
    ).toBe(true);
    expect(accepts([screenshot, screenshot, screenshot])).toBe(false);
    expect(accepts(Array.from({ length: 13 }, () => sleep))).toBe(false);
  });

  it("returns plain JSON when no screenshot was captured", () => {
    const output = computerAction.toModelOutput?.({
      data: [{ type: "get_mouse_position", x: 1, y: 2 }],
      message: "Executed 1 computer action.",
    });

    expect(JSON.stringify(output)).not.toContain("image/png");
  });
});
