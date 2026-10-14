import { describe, expect, it } from "vitest";
import { ImeInputGate } from "./ime-input";

describe("native IME input gate", () => {
  it("keeps preedit out of the document and commits composition once", () => {
    const gate = new ImeInputGate();
    gate.startComposition();

    expect(gate.acceptInput("ㄱ", { isComposing: true, inputType: "insertCompositionText" }, 10)).toBeNull();
    gate.updateComposition("가");
    expect(gate.finishComposition("", 20)).toBe("가");
    expect(gate.acceptInput("가", { inputType: "insertFromComposition" }, 21)).toBeNull();
    expect(gate.acceptInput("나", { inputType: "insertText" }, 22)).toBe("나");
  });

  it("does not suppress a later matching character outside the composition event window", () => {
    const gate = new ImeInputGate();
    gate.startComposition();
    expect(gate.finishComposition("가", 100)).toBe("가");
    expect(gate.acceptInput("가", { inputType: "insertText" }, 221)).toBe("가");
  });

  it("lets the OS IME handle navigation and editing keys during composition", () => {
    const gate = new ImeInputGate();
    gate.startComposition();

    expect(gate.shouldHandleKey(false, 0, "Backspace")).toBe(false);
    expect(gate.shouldHandleKey(true, 0, "Enter")).toBe(false);
    expect(gate.shouldHandleKey(false, 229, "ArrowLeft")).toBe(false);
    expect(gate.shouldHandleKey(false, 0, "ArrowLeft")).toBe(false);

    gate.finishComposition("가");
    expect(gate.shouldHandleKey(false, 0, "ArrowLeft")).toBe(true);
  });

  it("does not translate raw Latin input into Korean", () => {
    const gate = new ImeInputGate();
    expect(gate.acceptInput("rk", { inputType: "insertText" }, 5)).toBe("rk");
  });

  it("does not commit preedit text when the native IME cancels composition", () => {
    const gate = new ImeInputGate();
    gate.startComposition();
    gate.updateComposition("ㄱ");
    gate.cancelComposition();
    expect(gate.finishComposition("", 10)).toBeNull();
  });

  it("can commit WebKitGTK preedit when compositionstart was omitted", () => {
    const gate = new ImeInputGate();
    gate.updateComposition("가");
    expect(gate.finishComposition("", 10)).toBe("가");
  });
});
