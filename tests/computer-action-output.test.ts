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

    expect(JSON.stringify(output)).toContain("pasted-id");
    expect(JSON.stringify(output)).toContain("image/png");
  });
});
