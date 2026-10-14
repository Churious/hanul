// @vitest-environment node
import init, { HwpDocument } from "@rhwp/core";
import { readFile } from "node:fs/promises";
import { beforeAll } from "vitest";
import { describe, expect, it } from "vitest";
import { hanulDocumentEngine, rhwpDocumentEngine } from "./hwp-engine";
import { createRhwpPlainTextSerializer } from "./rhwp-plain-text-serializer";
import { HanulTextDocumentEngine } from "./text-document-engine";

beforeAll(async () => {
  const wasm = new Uint8Array(await readFile(new URL("../node_modules/@rhwp/core/rhwp_bg.wasm", import.meta.url)));
  await init({ module_or_path: wasm });
  Object.assign(globalThis, { measureTextWidth: (_font: string, text: string) => text.length * 8 });
});

describe("Hanul text engine serialization bridge", () => {
  it.each(["hwp", "hwpx"] as const)("serializes plain text to %s and reopens it", async (format) => {
    const engine = new HanulTextDocumentEngine(createRhwpPlainTextSerializer);
    const session = await engine.createBlank();
    let caret = session.hitTest(0, 113, 92);
    caret = session.insertText(caret, "Hanul 독립 편집 모델");
    session.applyParagraphAlignment(caret, "center");
    session.applyCharacterFormat(
      { ...caret, charOffset: 0 },
      { ...caret, charOffset: 5 },
      { bold: true, fontSize: 1600 },
    );
    caret = session.splitParagraph(caret);
    caret = session.insertPageBreak(caret);
    session.insertText(caret, "한글 IME 저장 왕복");

    const exported = session.exportWithReport(format);
    expect(exported.report.count).toBe(0);
    const reopened = await rhwpDocumentEngine.open(exported.bytes);
    try {
      expect(reopened.searchText("Hanul 독립 편집 모델").length).toBe(1);
      expect(reopened.searchText("한글 IME 저장 왕복").length).toBe(1);
      expect(reopened.pageCount).toBeGreaterThanOrEqual(2);
      const firstMatch = reopened.searchText("Hanul")[0];
      expect(reopened.characterProperties(firstMatch.start).bold).toBe(true);
      expect(reopened.paragraphProperties(firstMatch.start).alignment).toBe("center");
    } finally {
      reopened.dispose();
      session.dispose();
    }
  }, 120_000);

  it.each(["hwp", "hwpx"] as const)("imports supported %s paragraphs into the incremental engine", async (format) => {
    const engine = new HanulTextDocumentEngine(createRhwpPlainTextSerializer);
    const source = await engine.createBlank();
    let caret = source.hitTest(0, 113, 92);
    caret = source.insertText(caret, "첫 문단");
    caret = source.splitParagraph(caret);
    caret = source.insertText(caret, "둘째 문단");
    source.applyParagraphAlignment(caret, "center");
    source.applyParagraphFormat(caret, { marginLeft: 566.93, indent: 283.46 });
    source.applyCharacterFormat(
      { ...caret, charOffset: 0 },
      { ...caret, charOffset: 3 },
      { bold: true, fontSize: 1400, fontFamily: "맑은 고딕" },
    );
    source.insertPageBreak(source.searchText("둘째")[0].start);
    source.setPageDefinition(caret, { width: 215, marginLeft: 22, marginRight: 23 });
    const exported = source.exportWithReport(format);
    expect(exported.report.count).toBe(0);

    const imported = await hanulDocumentEngine.open(exported.bytes);
    try {
      expect(imported.engineId).toBe("hanul-text");
      expect(imported.sourceFormat).toBe(format);
      expect(imported.searchText("첫 문단").length).toBe(1);
      expect(imported.searchText("둘째 문단").length).toBe(1);
      expect(imported.pageCount).toBeGreaterThanOrEqual(2);
      expect(imported.pageDefinition(0).width).toBeCloseTo(215, 1);
      expect(imported.pageDefinition(0).marginLeft).toBeCloseTo(22, 1);
      const first = imported.searchText("첫 문단")[0];
      expect(imported.paragraphProperties(first.start).alignment).toBe("justify");
      expect(imported.characterProperties(first.start).fontSize).toBe(1000);
      const second = imported.searchText("둘째")[0];
      expect(imported.paragraphProperties(second.start).alignment).toBe("center");
      expect(imported.paragraphProperties(second.start).marginLeft).toBeCloseTo(3.8, 1);
      expect(imported.paragraphProperties(second.start).indent).toBeCloseTo(1.9, 1);
      expect(imported.characterProperties(second.start).bold).toBe(true);
      expect(imported.characterProperties(second.start).fontSize).toBe(1400);
      expect(imported.characterProperties(second.start).fontFamily).toBe("맑은 고딕");

      let edit = imported.insertText(imported.moveCaretToParagraphEdge(second.start, "end"), " 수정");
      expect(imported.searchText("둘째 문단 수정").length).toBe(1);
      edit = imported.undo() ?? edit;
      expect(imported.searchText("둘째 문단 수정").length).toBe(0);
      imported.redo();
      expect(imported.searchText("둘째 문단 수정").length).toBe(1);
      const changedPage = imported.pageDefinition(0);
      const pageCaret = imported.searchText("첫 문단")[0].start;
      imported.setPageDefinition(pageCaret, { width: 220 });
      expect(imported.pageDefinition(0).width).toBeCloseTo(220, 1);
      imported.undo();
      expect(imported.pageDefinition(0).width).toBeCloseTo(changedPage.width, 1);
      const savedAgain = imported.exportWithReport(format);
      try {
        expect(savedAgain.report.count).toBe(0);
        const reopened = await hanulDocumentEngine.open(savedAgain.bytes);
        try {
          expect(reopened.engineId).toBe("hanul-text");
          expect(reopened.searchText("첫 문단").length).toBe(1);
          expect(reopened.searchText("둘째 문단 수정").length).toBe(1);
          expect(reopened.pageCount).toBeGreaterThanOrEqual(2);
          expect(reopened.pageDefinition(0).width).toBeCloseTo(215, 1);
          expect(reopened.characterProperties(reopened.searchText("둘째")[0].start).bold).toBe(true);
        } finally {
          reopened.dispose();
        }
      } finally {
        savedAgain.bytes.fill(0);
      }
    } finally {
      imported.dispose();
      source.dispose();
    }
  }, 120_000);

  it("keeps a document with a table on the RHWP compatibility engine", async () => {
    const source = HwpDocument.createEmpty();
    let bytes: Uint8Array<ArrayBufferLike>;
    try {
      source.createBlankDocument();
      source.insertText(0, 0, 0, "표 포함 문서");
      const table = JSON.parse(source.createTable(0, 0, 6, 2, 2)) as { ok: boolean };
      expect(table.ok).toBe(true);
      const exported = source.exportHwpWithReport();
      try {
        bytes = exported.takeBytes();
      } finally {
        exported.free();
      }
    } finally {
      source.free();
    }

    const opened = await hanulDocumentEngine.open(bytes!);
    try {
      expect(opened.engineId).toBeUndefined();
      expect(opened.searchText("표 포함").length).toBe(1);
      const saved = opened.exportWithReport("hwp");
      try {
        const reopened = new HwpDocument(saved.bytes);
        try {
          const controls = JSON.parse(reopened.getControls()) as Array<{ ctrlId: string }>;
          expect(controls.some((control) => control.ctrlId === "tbl")).toBe(true);
        } finally {
          reopened.free();
        }
      } finally {
        saved.bytes.fill(0);
      }
    } finally {
      opened.dispose();
    }
  }, 120_000);
});
