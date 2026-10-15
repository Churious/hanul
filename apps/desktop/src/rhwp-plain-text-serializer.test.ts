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

  it("imports a basic table following body text into the Hanul engine", async () => {
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
      expect(opened.engineId).toBe("hanul-text");
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

  it.each(["hwp", "hwpx"] as const)("imports, edits and reopens Hanul table blocks through %s", async (format) => {
    const engine = new HanulTextDocumentEngine(createRhwpPlainTextSerializer);
    const source = await engine.createBlank();
    const anchor = source.hitTest(0, 113, 92);
    let cell = source.createTable(anchor, 2, 2);
    cell = source.insertText(cell, "첫 셀");
    const firstCellStart = { ...cell, charOffset: 0 };
    source.applyCharacterFormat(firstCellStart, { ...cell, charOffset: cell.charOffset }, { bold: true, fontSize: 1400 });
    let otherCell = source.moveTableCell(cell, 1);
    otherCell = source.insertText(otherCell, "두 번째 셀");
    source.updateTable(firstCellStart, {
      widthMm: 130,
      offsetXmm: 2,
      offsetYmm: 1,
      horizontalAlignment: "Center",
      rowHeightMm: 10,
      cellPaddingMm: 1.25,
      cellFillColor: "#fff2cc",
      borderColor: "#aa2200",
    });
    source.editTable(firstCellStart, "mergeRight");
    source.editTable(firstCellStart, "insertColumnRight");

    const initial = source.exportWithReport(format);
    expect(initial.report.count).toBe(0);
    try {
      const imported = await hanulDocumentEngine.open(initial.bytes);
      try {
        expect(imported.engineId).toBe("hanul-text");
        expect(imported.searchText("첫 셀")).toHaveLength(1);
        expect(imported.searchText("두 번째 셀")).toHaveLength(1);
        const first = imported.searchText("첫 셀")[0];
        expect(first.start.cellPath?.[0].cellIndex).toBe(0);
        expect(imported.characterProperties(first.start).bold).toBe(true);
        expect(imported.searchText("두 번째 셀")[0].start.cellPath?.[0].cellIndex).toBe(0);
        const importedTableLayout = imported.tableLayout(first.start);
        expect(importedTableLayout.widthMm).toBeCloseTo(130, 1);
        expect(importedTableLayout).toMatchObject({ horizontalAlignment: "Center", cellFillColor: "#fff2cc", cellBorderColor: "#aa2200" });
        expect(importedTableLayout.rowHeightMm).toBeCloseTo(10, 2);
        expect(importedTableLayout.cellPaddingMm).toBeCloseTo(1.25, 2);
        const changed = imported.insertText(imported.moveCaretToParagraphEdge(imported.searchText("두 번째 셀")[0].start, "end"), " 편집");
        expect(imported.searchText("두 번째 셀 편집")).toHaveLength(1);
        imported.undo();
        expect(imported.searchText("두 번째 셀 편집")).toHaveLength(0);
        imported.redo();
        expect(imported.searchText("두 번째 셀 편집")).toHaveLength(1);
        expect(imported.renderPage(0)).toContain("<rect");

        const saved = imported.exportWithReport(format);
        expect(saved.report.count).toBe(0);
        try {
          const reopened = await hanulDocumentEngine.open(saved.bytes);
          try {
            expect(reopened.engineId).toBe("hanul-text");
            expect(reopened.searchText("두 번째 셀 편집")).toHaveLength(1);
            expect(reopened.searchText("첫 셀")).toHaveLength(1);
          } finally {
            reopened.dispose();
          }
          const raw = new HwpDocument(saved.bytes);
          try {
            const tableControl = (JSON.parse(raw.getControls()) as Array<{ ctrlId: string; para: number; controlIndex: number }>).find((item) => item.ctrlId === "tbl");
            expect(tableControl).toBeDefined();
            const dimensions = JSON.parse(raw.getTableDimensions(0, tableControl!.para, tableControl!.controlIndex)) as { rowCount: number; colCount: number; cellCount: number };
            expect(dimensions).toMatchObject({ rowCount: 2, colCount: 3, cellCount: 5 });
            const mergedCell = JSON.parse(raw.getCellInfo(0, tableControl!.para, tableControl!.controlIndex, 0)) as { row: number; col: number; rowSpan: number; colSpan: number };
            expect(mergedCell).toMatchObject({ row: 0, col: 0, rowSpan: 1, colSpan: 2 });
            const savedTableProperties = JSON.parse(raw.getTableProperties(0, tableControl!.para, tableControl!.controlIndex)) as { horzAlign: string; horzOffset: number; vertOffset: number };
            expect(savedTableProperties.horzAlign).toBe("Center");
            expect(savedTableProperties.horzOffset).toBeGreaterThan(0);
            expect(savedTableProperties.vertOffset).toBeGreaterThan(0);
            const savedCell = JSON.parse(raw.getCellOwnProperties(0, tableControl!.para, tableControl!.controlIndex, 0)) as { width: number; height: number; fillType: string; fillColor: string; borderLeft: { color: string }; paddingLeft: number };
            expect(savedCell.width).toBeGreaterThan(0);
            expect(savedCell.height).toBeGreaterThan(0);
            expect(savedCell.paddingLeft).toBeGreaterThan(0);
            expect(savedCell.fillType).toBe("solid");
            expect(savedCell.fillColor).toBe("#fff2cc");
            expect(savedCell.borderLeft.color).toBe("#aa2200");
          } finally {
            raw.free();
          }
        } finally {
          saved.bytes.fill(0);
        }
        void changed;
      } finally {
        imported.dispose();
      }
    } finally {
      initial.bytes.fill(0);
      source.dispose();
    }
  }, 120_000);

  it.each(["hwp", "hwpx"] as const)("imports, edits and reopens a multi-page table through %s", async (format) => {
    const engine = new HanulTextDocumentEngine(createRhwpPlainTextSerializer);
    const source = await engine.createBlank();
    const originalText = `${"페이지 경계를 넘는 표 셀 문장입니다. ".repeat(300)}고유 끝 표식 2026`;
    const cell = source.createTable(source.hitTest(0, 113, 92), 1, 1);
    source.insertText(cell, originalText);
    const initial = source.exportWithReport(format);
    expect(initial.report.count).toBe(0);
    try {
      const imported = await hanulDocumentEngine.open(initial.bytes);
      try {
        expect(imported.engineId).toBe("hanul-text");
        expect(imported.pageCount).toBeGreaterThan(1);
        expect(imported.searchText(originalText)).toHaveLength(1);
        const laterPage = imported.searchText("고유 끝 표식 2026")[0].start.cursorRect.pageIndex;
        expect(laterPage).toBeGreaterThan(0);
        const textLine = [...imported.renderPage(laterPage).matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>(.*?)<\/text>/g)]
          .find((match) => match[3].includes("고유 끝 표식"));
        expect(textLine).toBeDefined();
        const lineText = textLine![3];
        const position = imported.hitTest(laterPage, Number(textLine![1]) + 1, Number(textLine![2]));
        expect(position.cursorRect.pageIndex).toBe(laterPage);
        imported.insertText(position, "!");
        expect(imported.searchText(`!${lineText.slice(0, 8)}`)).toHaveLength(1);
        imported.undo();
        expect(imported.searchText(originalText)).toHaveLength(1);
        imported.redo();

        const saved = imported.exportWithReport(format);
        expect(saved.report.count).toBe(0);
        try {
          const reopened = await hanulDocumentEngine.open(saved.bytes);
          try {
            expect(reopened.engineId).toBe("hanul-text");
            expect(reopened.searchText("고유 끝 표식 2026")).toHaveLength(1);
            expect(reopened.searchText(`!${lineText.slice(0, 8)}`)).toHaveLength(1);
          } finally {
            reopened.dispose();
          }
        } finally {
          saved.bytes.fill(0);
        }
      } finally {
        imported.dispose();
      }
    } finally {
      initial.bytes.fill(0);
      source.dispose();
    }
  }, 120_000);

  it("keeps floating tables on the RHWP compatibility path", async () => {
    const raw = HwpDocument.createEmpty();
    let bytes: Uint8Array<ArrayBufferLike>;
    try {
      raw.createBlankDocument();
      const created = JSON.parse(raw.createTable(0, 0, 0, 1, 1)) as { ok: boolean; paraIdx: number; controlIdx: number };
      expect(created.ok).toBe(true);
      expect(JSON.parse(raw.setTableProperties(0, created.paraIdx, created.controlIdx, JSON.stringify({ textWrap: "InFrontOfText" }))).ok).toBe(true);
      const exported = raw.exportHwpWithReport();
      try {
        bytes = exported.takeBytes();
      } finally {
        exported.free();
      }
    } finally {
      raw.free();
    }
    const opened = await hanulDocumentEngine.open(bytes!);
    try {
      expect(opened.engineId).toBe("rhwp-compat");
      expect(opened.renderPage(0)).toContain("<svg");
    } finally {
      opened.dispose();
      bytes!.fill(0);
    }
  }, 120_000);

  it.each(["hwp", "hwpx"] as const)("round-trips rowspan and colspan in %s", async (format) => {
    const engine = new HanulTextDocumentEngine(createRhwpPlainTextSerializer);
    const source = await engine.createBlank();
    const tableStart = source.createTable(source.hitTest(0, 113, 92), 2, 2);
    source.insertText(tableStart, "병합 영역");
    source.editTable(tableStart, "mergeDown");
    const exported = source.exportWithReport(format);
    expect(exported.report.count).toBe(0);
    try {
      const imported = await hanulDocumentEngine.open(exported.bytes);
      try {
        expect(imported.engineId).toBe("hanul-text");
        expect(imported.searchText("병합 영역")).toHaveLength(1);
        const reopened = imported.exportWithReport(format);
        try {
          const raw = new HwpDocument(reopened.bytes);
          try {
            const control = (JSON.parse(raw.getControls()) as Array<{ ctrlId: string; para: number; controlIndex: number }>).find((item) => item.ctrlId === "tbl")!;
            const dims = JSON.parse(raw.getTableDimensions(0, control.para, control.controlIndex)) as { cellCount: number };
            expect(dims.cellCount).toBe(3);
            const merged = JSON.parse(raw.getCellInfo(0, control.para, control.controlIndex, 0)) as { row: number; col: number; rowSpan: number; colSpan: number };
            expect(merged).toMatchObject({ row: 0, col: 0, rowSpan: 2, colSpan: 1 });
          } finally {
            raw.free();
          }
        } finally {
          reopened.bytes.fill(0);
        }
      } finally {
        imported.dispose();
      }
    } finally {
      exported.bytes.fill(0);
      source.dispose();
    }
  }, 120_000);
});
