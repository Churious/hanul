import { describe, expect, it } from "vitest";
import type { DocumentObject } from "./document-engine";
import { previewObjectDrag } from "./object-drag";

const object = {
  id: "shape-1",
  kind: "rectangle",
  sectionIndex: 0,
  paragraphIndex: 0,
  controlIndex: 0,
  pageIndex: 0,
  bounds: { pageIndex: 0, x: 100, y: 200, width: 80, height: 40 },
  zOrder: 0,
  widthMm: 21.17,
  heightMm: 10.58,
  offsetXmm: 0,
  offsetYmm: 0,
  textWrap: "Square",
  treatAsCharacter: false,
  description: "",
} satisfies DocumentObject;

describe("previewObjectDrag", () => {
  it("moves the visual bounds without changing size", () => {
    expect(previewObjectDrag(object, { x: 120, y: 220 }, { x: 145, y: 208 }, false))
      .toEqual({ x: 125, y: 188, width: 80, height: 40 });
  });

  it("previews resize and clamps to the document minimum size", () => {
    expect(previewObjectDrag(object, { x: 180, y: 240 }, { x: 195, y: 252 }, true))
      .toEqual({ x: 100, y: 200, width: 95, height: 52 });
    expect(previewObjectDrag(object, { x: 180, y: 240 }, { x: 0, y: 0 }, true))
      .toEqual({ x: 100, y: 200, width: 96 / 25.4, height: 96 / 25.4 });
  });
});
