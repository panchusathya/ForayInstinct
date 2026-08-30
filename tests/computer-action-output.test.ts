import { describe, expect, it } from "vitest";
import computerAction from "../agent/subagents/worker/tools/computer_action";

describe("computer_action model output", () => {
  it("keeps structured action data when a screenshot is included", () => {
    const output = computerAction.toModelOutput?.({
      data: [{ type: "read_clipboard", text: "pasted-id" }],
      message: "Executed 2 computer actions.",
      mimeType: "image/png",
      screenshotBase64: "aaaa",
    });

    expect(output).toEqual(
      expect.objectContaining({
        type: "content",
      })
    );
    const content =
      output && "value" in output && Array.isArray(output.value)
        ? output.value
        : [];
    const text = content.find(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text"
    );
    expect(text).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("pasted-id"),
      })
    );
  });
});
