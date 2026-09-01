import { describe, expect, it } from "vitest";
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

  it("returns plain JSON when no screenshot was captured", () => {
    const output = computerAction.toModelOutput?.({
      data: [{ type: "get_mouse_position", x: 1, y: 2 }],
      message: "Executed 1 computer action.",
    });

    expect(JSON.stringify(output)).not.toContain("image/png");
  });
});
