import { describe, expect, it } from "vitest";
import { mapKernelKey } from "../src/actions.ts";

describe("mapKernelKey", () => {
  it("maps modifier aliases", () => {
    expect(mapKernelKey("ctrl")).toBe("Control");
    expect(mapKernelKey("control")).toBe("Control");
    expect(mapKernelKey("cmd")).toBe("Meta");
    expect(mapKernelKey("meta")).toBe("Meta");
    expect(mapKernelKey("super")).toBe("Meta");
    expect(mapKernelKey("shift")).toBe("Shift");
    expect(mapKernelKey("alt")).toBe("Alt");
  });

  it("maps navigation and editing keys", () => {
    expect(mapKernelKey("enter")).toBe("Enter");
    expect(mapKernelKey("tab")).toBe("Tab");
    expect(mapKernelKey("esc")).toBe("Escape");
    expect(mapKernelKey("backspace")).toBe("Backspace");
    expect(mapKernelKey("delete")).toBe("Delete");
    expect(mapKernelKey("space")).toBe(" ");
    expect(mapKernelKey("pageup")).toBe("PageUp");
    expect(mapKernelKey("pagedown")).toBe("PageDown");
    expect(mapKernelKey("home")).toBe("Home");
    expect(mapKernelKey("end")).toBe("End");
  });

  it("maps arrows", () => {
    expect(mapKernelKey("up")).toBe("ArrowUp");
    expect(mapKernelKey("down")).toBe("ArrowDown");
    expect(mapKernelKey("left")).toBe("ArrowLeft");
    expect(mapKernelKey("right")).toBe("ArrowRight");
    expect(mapKernelKey("arrowup")).toBe("ArrowUp");
  });

  it("is case-insensitive on names", () => {
    expect(mapKernelKey("CTRL")).toBe("Control");
    expect(mapKernelKey("Enter")).toBe("Enter");
  });

  it("uppercases function keys", () => {
    expect(mapKernelKey("f1")).toBe("F1");
    expect(mapKernelKey("f12")).toBe("F12");
  });

  it("passes single characters and unknown names through", () => {
    expect(mapKernelKey("a")).toBe("a");
    expect(mapKernelKey("A")).toBe("A");
    expect(mapKernelKey("-")).toBe("-");
    expect(mapKernelKey("KeyQ")).toBe("KeyQ");
  });
});
