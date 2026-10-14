// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import init, { HwpDocument } from "@rhwp/core";
import { readFile } from "node:fs/promises";
import {
  createNewHwpDocumentSession,
  wrapHwpDocument,
  type TableCommand,
} from "./hwp-engine";

beforeAll(async () => {
  const wasm = new Uint8Array(
    await readFile(new URL("../node_modules/@rhwp/core/rhwp_bg.wasm", import.meta.url)),
  );
  await init({ module_or_path: wasm });
  Object.assign(globalThis, {
    measureTextWidth: (_font: string, text: string) => text.length * 8,
  });
});

describe("RHWP document session", () => {
  it("keeps only the twelve most recently used rendered pages", () => {
    const document = HwpDocument.createEmpty();
    document.createBlankDocument();
    document.insertText(
      0,
      0,
      0,
      ("SVG cache bound benchmark sentence 0123456789 가나다라마바사아자차카타파하\n").repeat(500),
    );
    expect(document.pageCount()).toBeGreaterThan(12);

    const renderSpy = vi.spyOn(document, "renderPageSvg");
    const session = wrapHwpDocument(document);
    try {
      for (let pageIndex = 0; pageIndex <= 12; pageIndex += 1) session.renderPage(pageIndex);
      session.renderPage(1); // Refresh page 1 before asking for an evicted page.
      session.renderPage(0); // Page 0 was the least recently used entry.
      session.renderPage(1); // Page 1 should still be cached.

      expect(renderSpy).toHaveBeenCalledTimes(14);
    } finally {
      session.dispose();
      vi.restoreAllMocks();
    }
  });

  it("edits Korean text, undoes paragraph changes, and round-trips HWP without reported loss", async () => {
    const session = await createNewHwpDocumentSession();
    const contains = (text: string) => session.searchText(text, false).length > 0;
    try {
      const position = session.hitTest(0, 113, 132);
      expect(position.sectionIndex).toBe(0);
      expect(position.paragraphIndex).toBe(0);

      const inserted = session.insertText(position, "한글 편집");
      expect(contains("한글 편집")).toBe(true);

      const undoneInsert = session.undo();
      expect(undoneInsert).not.toBeNull();
      expect(contains("한글 편집")).toBe(false);
      expect(session.canRedo).toBe(true);

      const redoneInsert = session.redo();
      expect(redoneInsert?.charOffset).toBe(inserted.charOffset);
      expect(contains("한글 편집")).toBe(true);

      const deleted = session.deleteText(redoneInsert!, "backward");
      expect(contains("한글 편")).toBe(true);
      session.undo();
      expect(contains("한글 편집")).toBe(true);
      const redoneDelete = session.redo();
      expect(contains("한글 편")).toBe(true);
      const restored = session.insertText(redoneDelete ?? deleted, "집");
      expect(contains("한글 편집")).toBe(true);

      session.splitParagraph(restored);
      expect(session.searchText("한글 편집", false)).toHaveLength(1);
      session.undo();
      expect(contains("한글 편집")).toBe(true);
      const splitAgain = session.redo();
      expect(splitAgain?.paragraphIndex).toBe(1);

      const merged = session.deleteText(splitAgain!, "backward");
      expect(contains("한글 편집")).toBe(true);
      session.undo();
      expect(contains("한글 편집")).toBe(true);
      session.redo();
      expect(merged.paragraphIndex).toBe(0);

      const exported = session.exportWithReport();
      expect(exported.report.outputFormat).toBe("hwp");
      expect(exported.report.count).toBe(0);
      const reopenedDocument = new HwpDocument(exported.bytes);
      const reopened = wrapHwpDocument(reopenedDocument);
      try {
        expect(reopened.searchText("한글 편집", false)).toHaveLength(1);
        expect(reopened.pageCount).toBe(1);
      } finally {
        reopened.dispose();
      }
    } finally {
      session.dispose();
    }
  });

  it("creates an editable one-page HWP document", async () => {
    const session = await createNewHwpDocumentSession();
    try {
      expect(session.sourceFormat).toBe("hwp");
      expect(session.pageCount).toBe(1);
      expect(session.renderPage(0)).toContain("<svg");
      expect(session.canUndo).toBe(false);
      const exported = session.exportWithReport();
      expect(exported.report.outputFormat).toBe("hwp");
      expect(exported.report.count).toBe(0);
      expect(exported.bytes.byteLength).toBeGreaterThan(0);
    } finally {
      session.dispose();
    }
  });

  it("exposes page and document metadata through the session adapter", async () => {
    const session = await createNewHwpDocumentSession();
    try {
      expect(session.documentInfo()).toMatchObject({
        sectionCount: 1,
        pageCount: 1,
        encrypted: false,
      });
      expect(session.pageInfo(0)).toMatchObject({
        pageIndex: 0,
        pageNumber: 1,
        sectionIndex: 0,
      });
      expect(session.pageInfo(0).width).toBeGreaterThan(0);
      expect(session.pageInfo(0).height).toBeGreaterThan(0);
      expect(() => session.pageInfo(-1)).toThrow(RangeError);
      expect(() => session.pageInfo(session.pageCount)).toThrow(RangeError);
    } finally {
      session.dispose();
    }
  });

  it("exports a document to either supported format and reopens the result", async () => {
    const session = await createNewHwpDocumentSession();
    let reopenedHwp: ReturnType<typeof wrapHwpDocument> | null = null;
    let reopenedHwpx: ReturnType<typeof wrapHwpDocument> | null = null;
    try {
      const start = session.hitTest(0, 113, 132);
      session.insertText(start, "다른 이름으로 저장 형식 확인");

      const asHwp = session.exportWithReport("hwp");
      expect(asHwp.report).toMatchObject({ outputFormat: "hwp", count: 0 });
      reopenedHwp = wrapHwpDocument(new HwpDocument(asHwp.bytes));
      expect(reopenedHwp.searchText("다른 이름으로 저장 형식 확인", false)).toHaveLength(1);

      const asHwpx = session.exportWithReport("hwpx");
      expect(asHwpx.report).toMatchObject({ outputFormat: "hwpx", count: 0 });
      reopenedHwpx = wrapHwpDocument(new HwpDocument(asHwpx.bytes));
      expect(reopenedHwpx.searchText("다른 이름으로 저장 형식 확인", false)).toHaveLength(1);
    } finally {
      reopenedHwp?.dispose();
      reopenedHwpx?.dispose();
      session.dispose();
    }
  });

  it("inserts an undoable page break and preserves it through HWP export and reopen", async () => {
    const session = await createNewHwpDocumentSession();
    let reopened: ReturnType<typeof wrapHwpDocument> | null = null;
    try {
      const start = session.hitTest(0, 113, 132);
      const textEnd = session.insertText(start, "첫 쪽 내용");
      const afterBreak = session.insertPageBreak(textEnd);
      expect(session.pageCount).toBe(2);
      expect(session.searchText("첫 쪽 내용", false)).toHaveLength(1);
      const secondPageEnd = session.insertText(afterBreak, "다음 쪽 입력");
      expect(secondPageEnd.cursorRect.pageIndex).toBe(1);
      expect(session.searchText("다음 쪽 입력", false)).toHaveLength(1);

      session.undo();
      expect(session.searchText("다음 쪽 입력", false)).toHaveLength(0);
      session.undo();
      expect(session.pageCount).toBe(1);
      session.redo();
      expect(session.pageCount).toBe(2);
      session.redo();
      expect(session.searchText("다음 쪽 입력", false)).toHaveLength(1);
      expect(afterBreak.cursorRect.pageIndex).toBe(1);

      const saved = session.exportWithReport();
      expect(saved.report.count).toBe(0);
      reopened = wrapHwpDocument(new HwpDocument(saved.bytes));
      expect(reopened.pageCount).toBe(2);
      expect(reopened.searchText("첫 쪽 내용", false)).toHaveLength(1);
    } finally {
      reopened?.dispose();
      session.dispose();
    }
  });

  it("preserves an editable page break through HWPX export and reopen", async () => {
    const source = HwpDocument.createEmpty();
    let session: ReturnType<typeof wrapHwpDocument> | null = null;
    let reopened: ReturnType<typeof wrapHwpDocument> | null = null;
    try {
      source.createBlankDocument();
      const initial = source.exportHwpxWithReport();
      let bytes: Uint8Array;
      try {
        expect(JSON.parse(initial.contentLoss()).count).toBe(0);
        bytes = initial.takeBytes();
      } finally {
        initial.free();
      }
      session = wrapHwpDocument(new HwpDocument(bytes));
      const start = session.hitTest(0, 113, 132);
      const textEnd = session.insertText(start, "첫 쪽 내용");
      const afterBreak = session.insertPageBreak(textEnd);
      expect(afterBreak.cursorRect.pageIndex).toBe(1);
      const secondPageEnd = session.insertText(afterBreak, "HWPX 다음 쪽 입력");
      expect(secondPageEnd.cursorRect.pageIndex).toBe(1);
      expect(session.pageCount).toBe(2);

      const saved = session.exportWithReport();
      expect(saved.report.outputFormat).toBe("hwpx");
      expect(saved.report.count).toBe(0);
      reopened = wrapHwpDocument(new HwpDocument(saved.bytes));
      expect(reopened.sourceFormat).toBe("hwpx");
      expect(reopened.pageCount).toBe(2);
      expect(reopened.searchText("첫 쪽 내용", false)).toHaveLength(1);
      expect(reopened.searchText("HWPX 다음 쪽 입력", false)).toHaveLength(1);
    } finally {
      reopened?.dispose();
      session?.dispose();
      source.free();
    }
  });

  it("edits and reopens HWPX without losing the source text", async () => {
    const source = HwpDocument.createEmpty();
    let sourceSession: ReturnType<typeof wrapHwpDocument> | null = null;
    let reopenedSession: ReturnType<typeof wrapHwpDocument> | null = null;
    try {
      source.createBlankDocument();
      const sourcePosition = JSON.parse(source.hitTest(0, 113, 132)) as {
        sectionIndex: number;
        paragraphIndex: number;
        charOffset: number;
      };
      source.insertText(sourcePosition.sectionIndex, sourcePosition.paragraphIndex, sourcePosition.charOffset, "원본 HWPX 문서");
      const initialExport = source.exportHwpxWithReport();
      let hwpxBytes: Uint8Array;
      try {
        expect(JSON.parse(initialExport.contentLoss()).count).toBe(0);
        hwpxBytes = initialExport.takeBytes();
      } finally {
        initialExport.free();
      }

      sourceSession = wrapHwpDocument(new HwpDocument(hwpxBytes));
      expect(sourceSession.sourceFormat).toBe("hwpx");
      expect(sourceSession.searchText("원본 HWPX 문서", false)).toHaveLength(1);

      const start = sourceSession.hitTest(0, 113, 132);
      sourceSession.insertText(start, " 편집 저장 검증");
      const saved = sourceSession.exportWithReport();
      expect(saved.report.outputFormat).toBe("hwpx");
      expect(saved.report.count).toBe(0);

      reopenedSession = wrapHwpDocument(new HwpDocument(saved.bytes));
      expect(reopenedSession.sourceFormat).toBe("hwpx");
      expect(reopenedSession.searchText("원본 HWPX 문서", false)).toHaveLength(1);
      expect(reopenedSession.searchText("편집 저장 검증", false)).toHaveLength(1);
      expect(reopenedSession.pageCount).toBe(1);
    } finally {
      reopenedSession?.dispose();
      sourceSession?.dispose();
      source.free();
    }
  });

  it("round-trips formatted body text and table-cell text in HWPX", async () => {
    const source = HwpDocument.createEmpty();
    let sourceSession: ReturnType<typeof wrapHwpDocument> | null = null;
    let reopenedSession: ReturnType<typeof wrapHwpDocument> | null = null;
    try {
      source.createBlankDocument();
      const initialExport = source.exportHwpxWithReport();
      let hwpxBytes: Uint8Array;
      try {
        expect(JSON.parse(initialExport.contentLoss()).count).toBe(0);
        hwpxBytes = initialExport.takeBytes();
      } finally {
        initialExport.free();
      }

      sourceSession = wrapHwpDocument(new HwpDocument(hwpxBytes));
      const start = sourceSession.hitTest(0, 113, 132);
      const bodyEnd = sourceSession.insertText(start, "서식 보존");
      const secondStart = sourceSession.splitParagraph(bodyEnd);
      const secondEnd = sourceSession.insertText(secondStart, "두 번째 문단");
      expect(sourceSession.selectedText(start, secondEnd)).toBe("서식 보존\n두 번째 문단");
      expect(sourceSession.selectionRectangles(start, secondEnd).length).toBeGreaterThan(0);
      sourceSession.applyCharacterFormat(start, secondEnd, { bold: true, underline: true, fontSize: 1400 });
      const tableStart = sourceSession.createTable(secondEnd, 2, 2);
      sourceSession.insertText(tableStart, "표 셀 보존");
      expect(sourceSession.searchText("표 셀 보존", true)).toHaveLength(1);

      const saved = sourceSession.exportWithReport();
      expect(saved.report.outputFormat).toBe("hwpx");
      expect(saved.report.count).toBe(0);

      reopenedSession = wrapHwpDocument(new HwpDocument(saved.bytes));
      expect(reopenedSession.searchText("서식 보존", false)).toHaveLength(1);
      expect(reopenedSession.searchText("두 번째 문단", false)).toHaveLength(1);
      expect(reopenedSession.searchText("표 셀 보존", true)).toHaveLength(1);
      expect(reopenedSession.renderPage(0)).toContain("font-weight");
      const firstParagraphProperties = reopenedSession.characterProperties(start);
      const secondParagraphProperties = reopenedSession.characterProperties({ ...secondEnd, charOffset: secondEnd.charOffset - 1 });
      expect(Boolean(firstParagraphProperties.bold)).toBe(true);
      expect(Boolean(firstParagraphProperties.underline)).toBe(true);
      expect(firstParagraphProperties.fontSize).toBe(1400);
      expect(Boolean(secondParagraphProperties.bold)).toBe(true);
      expect(Boolean(secondParagraphProperties.underline)).toBe(true);
      expect(secondParagraphProperties.fontSize).toBe(1400);
    } finally {
      reopenedSession?.dispose();
      sourceSession?.dispose();
      source.free();
    }
  });

  it("selects and formats text across paragraphs, then deletes it with undo and redo", async () => {
    const session = await createNewHwpDocumentSession();
    try {
      const firstStart = session.hitTest(0, 113, 132);
      const firstEnd = session.insertText(firstStart, "첫 문단");
      const secondStart = session.splitParagraph(firstEnd);
      const secondEnd = session.insertText(secondStart, "둘째 문단");

      expect(session.selectedText(firstStart, secondStart)).toBe("첫 문단\n");
      expect(session.selectionRectangles(firstStart, secondStart).length).toBeGreaterThan(0);
      expect(session.selectedText(firstStart, secondEnd)).toBe("첫 문단\n둘째 문단");
      expect(session.selectionRectangles(firstStart, secondEnd).length).toBeGreaterThan(0);

      session.applyCharacterFormat(firstStart, secondEnd, { bold: true });
      const lastSecondCharacter = { ...secondEnd, charOffset: secondEnd.charOffset - 1 };
      expect(Boolean(session.characterProperties(firstStart).bold)).toBe(true);
      expect(Boolean(session.characterProperties(lastSecondCharacter).bold)).toBe(true);
      session.undo();
      expect(Boolean(session.characterProperties(firstStart).bold)).toBe(false);
      expect(Boolean(session.characterProperties(lastSecondCharacter).bold)).toBe(false);
      session.redo();
      expect(Boolean(session.characterProperties(firstStart).bold)).toBe(true);
      expect(Boolean(session.characterProperties(lastSecondCharacter).bold)).toBe(true);

      const saved = session.exportWithReport();
      expect(saved.report.count).toBe(0);
      const reopened = wrapHwpDocument(new HwpDocument(saved.bytes));
      try {
        const reopenedStart = reopened.hitTest(0, 113, 132);
        expect(reopened.searchText("첫 문단", false)).toHaveLength(1);
        expect(reopened.searchText("둘째 문단", false)).toHaveLength(1);
        expect(Boolean(reopened.characterProperties(reopenedStart).bold)).toBe(true);
      } finally {
        reopened.dispose();
      }

      session.deleteRange(firstStart, secondEnd);
      expect(session.searchText("첫 문단", false)).toHaveLength(0);
      expect(session.searchText("둘째 문단", false)).toHaveLength(0);
      session.undo();
      expect(session.searchText("첫 문단", false)).toHaveLength(1);
      expect(session.searchText("둘째 문단", false)).toHaveLength(1);
      expect(Boolean(session.characterProperties(firstStart).bold)).toBe(true);
      session.redo();
      expect(session.searchText("첫 문단", false)).toHaveLength(0);
      expect(session.searchText("둘째 문단", false)).toHaveLength(0);
    } finally {
      session.dispose();
    }
  });

  it("finds and replaces text in the RHWP document model as one undoable edit", async () => {
    const session = await createNewHwpDocumentSession();
    try {
      const start = session.hitTest(0, 113, 132);
      const end = session.insertText(start, "반복 반복");
      expect(session.searchText("반복", false)).toHaveLength(2);

      const replaced = session.replaceAllText("반복", "한울");
      expect(replaced.count).toBe(2);
      expect(session.searchText("한울", false)).toHaveLength(2);
      expect(session.canUndo).toBe(true);

      session.undo();
      expect(session.searchText("반복", false)).toHaveLength(2);
      session.redo();
      expect(session.searchText("한울", false)).toHaveLength(2);

      const exported = session.exportWithReport();
      expect(exported.report.count).toBe(0);
      const reopened = wrapHwpDocument(new HwpDocument(exported.bytes));
      try {
        expect(reopened.searchText("한울", false)).toHaveLength(2);
      } finally {
        reopened.dispose();
      }
      expect(end.charOffset).toBe(5);
    } finally {
      session.dispose();
    }
  });

  it("keeps a single replaceRange insertion available to undo and redo", async () => {
    const session = await createNewHwpDocumentSession();
    try {
      const start = session.hitTest(0, 113, 132);

      session.replaceRange(start, start, "가");

      expect(session.searchText("가", false)).toHaveLength(1);
      expect(session.canUndo).toBe(true);
      session.undo();
      expect(session.searchText("가", false)).toHaveLength(0);
      expect(session.canRedo).toBe(true);
      session.redo();
      expect(session.searchText("가", false)).toHaveLength(1);
      expect(session.canUndo).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it("edits table rows and merges cells with snapshot-backed undo and redo", async () => {
    const session = await createNewHwpDocumentSession();
    try {
      const start = session.hitTest(0, 113, 132);
      const firstCell = session.createTable(start, 2, 2);
      const filledCell = session.insertText(firstCell, "셀 내용");
      const withRow = session.editTable(filledCell, "insertRowBelow");
      expect(withRow.cellPath?.[0].cellIndex).toBe(0);
      expect(session.searchText("셀 내용", true)).toHaveLength(1);

      const undoneRow = session.undo();
      expect(undoneRow?.cellPath?.[0].cellIndex).toBe(filledCell.cellPath?.[0].cellIndex);
      const redoneRow = session.redo();
      expect(redoneRow?.cellPath?.[0].cellIndex).toBe(withRow.cellPath?.[0].cellIndex);

      const merged = session.editTable(redoneRow!, "mergeRight");
      expect(session.searchText("셀 내용", true)).toHaveLength(1);
      expect(session.undo()?.cellPath?.[0].cellIndex).toBe(redoneRow?.cellPath?.[0].cellIndex);
      expect(session.redo()?.cellPath?.[0].cellIndex).toBe(merged.cellPath?.[0].cellIndex);

      const exported = session.exportWithReport();
      expect(exported.report.count).toBe(0);
      const reopened = wrapHwpDocument(new HwpDocument(exported.bytes));
      try {
        expect(reopened.searchText("셀 내용", true)).toHaveLength(1);
      } finally {
        reopened.dispose();
      }
    } finally {
      session.dispose();
    }
  });

  it("edits table rows, columns, merged cells and deleted cells without losing cell text", async () => {
    const session = await createNewHwpDocumentSession();
    const reopened: ReturnType<typeof wrapHwpDocument>[] = [];
    try {
      const start = session.hitTest(0, 113, 132);
      let position = session.insertText(session.createTable(start, 2, 2), "표 데이터");

      const verifyUndoRedo = (command: TableCommand) => {
        const after = session.editTable(position, command);
        expect(session.searchText("표 데이터", true)).toHaveLength(1);
        const undone = session.undo();
        expect(undone?.cellPath).toBeDefined();
        expect(session.searchText("표 데이터", true)).toHaveLength(1);
        position = session.redo()!;
        expect(position.cellPath).toEqual(after.cellPath);
        expect(session.searchText("표 데이터", true)).toHaveLength(1);
      };

      verifyUndoRedo("insertRowAbove");
      verifyUndoRedo("insertColumnLeft");
      verifyUndoRedo("insertColumnRight");
      verifyUndoRedo("mergeRight");
      verifyUndoRedo("splitCell");

      // The split exposes an empty neighboring column; deleting it keeps the original text.
      position = session.moveTableCell(position, 1);
      verifyUndoRedo("deleteColumn");

      // Inserted rows/columns leave an empty first row that can be removed safely.
      position = session.moveTableCell(session.moveTableCell(session.moveTableCell(position, -1), -1), -1);
      verifyUndoRedo("deleteRow");

      for (const format of ["hwp", "hwpx"] as const) {
        const exported = session.exportWithReport(format);
        expect(exported.report.count).toBe(0);
        const reopenedSession = wrapHwpDocument(new HwpDocument(exported.bytes));
        reopened.push(reopenedSession);
        expect(reopenedSession.searchText("표 데이터", true)).toHaveLength(1);
      }
    } finally {
      reopened.forEach((document) => document.dispose());
      session.dispose();
    }
  });

  it("applies paragraph and page settings with undo and keeps them in HWP and HWPX", async () => {
    const session = await createNewHwpDocumentSession();
    const reopened: ReturnType<typeof wrapHwpDocument>[] = [];
    try {
      const start = session.hitTest(0, 113, 132);
      session.insertText(start, "쪽 설정과 문단 서식");

      session.applyParagraphFormat(start, {
        alignment: "center",
        lineSpacing: 180,
        lineSpacingType: "Percent",
        marginLeft: 567,
        indent: 113,
      });
      expect(session.paragraphProperties(start)).toMatchObject({ alignment: "center", lineSpacing: 180 });
      expect(Number(session.paragraphProperties(start).marginLeft)).toBeCloseTo(3.8, 1);
      expect(Number(session.paragraphProperties(start).indent)).toBeCloseTo(0.7, 1);
      session.undo();
      expect(session.paragraphProperties(start).alignment).toBe("justify");
      session.redo();
      expect(session.paragraphProperties(start)).toMatchObject({ alignment: "center", lineSpacing: 180 });
      expect(Number(session.paragraphProperties(start).marginLeft)).toBeCloseTo(3.8, 1);
      expect(Number(session.paragraphProperties(start).indent)).toBeCloseTo(0.7, 1);

      const originalPage = session.pageDefinition(0);
      const changedPage = session.setPageDefinition(start, {
        marginLeft: originalPage.marginLeft + 1200,
        marginRight: originalPage.marginRight + 1200,
        landscape: true,
      });
      expect(session.pageDefinition(0)).toMatchObject({
        marginLeft: originalPage.marginLeft + 1200,
        marginRight: originalPage.marginRight + 1200,
        landscape: true,
      });
      session.undo();
      expect(session.pageDefinition(0)).toEqual(originalPage);
      session.redo();
      expect(session.pageDefinition(0).landscape).toBe(true);

      for (const format of ["hwp", "hwpx"] as const) {
        const saved = session.exportWithReport(format);
        expect(saved.report).toMatchObject({ outputFormat: format, count: 0 });
        const reopenedSession = wrapHwpDocument(new HwpDocument(saved.bytes));
        reopened.push(reopenedSession);
        expect(reopenedSession.searchText("쪽 설정과 문단 서식", false)).toHaveLength(1);
        expect(reopenedSession.paragraphProperties(start)).toMatchObject({ alignment: "center", lineSpacing: 180 });
        expect(Number(reopenedSession.paragraphProperties(start).marginLeft)).toBeCloseTo(3.8, 1);
        expect(Number(reopenedSession.paragraphProperties(start).indent)).toBeCloseTo(0.7, 1);
        expect(reopenedSession.pageDefinition(0)).toMatchObject({
          marginLeft: originalPage.marginLeft + 1200,
          marginRight: originalPage.marginRight + 1200,
          landscape: true,
        });
      }
      expect(changedPage.sectionIndex).toBe(start.sectionIndex);
    } finally {
      reopened.forEach((document) => document.dispose());
      session.dispose();
    }
  });

  it("applies an available document style with snapshot undo and redo", async () => {
    const session = await createNewHwpDocumentSession();
    let reopened: ReturnType<typeof wrapHwpDocument> | null = null;
    try {
      const start = session.hitTest(0, 113, 132);
      session.insertText(start, "스타일 적용");
      const styles = session.styleList();
      expect(styles.length).toBeGreaterThan(0);
      const selectedStyle = styles[styles.length - 1]!;
      session.applyStyle(start, selectedStyle.id);
      expect(session.canUndo).toBe(true);
      session.undo();
      session.redo();

      const saved = session.exportWithReport("hwpx");
      expect(saved.report).toMatchObject({ outputFormat: "hwpx", count: 0 });
      reopened = wrapHwpDocument(new HwpDocument(saved.bytes));
      expect(reopened.searchText("스타일 적용", false)).toHaveLength(1);
      expect(reopened.styleList()).toContainEqual(expect.objectContaining({ id: selectedStyle.id, name: selectedStyle.name }));
    } finally {
      reopened?.dispose();
      session.dispose();
    }
  });

  it("inserts a picture as an undoable document object and reopens it from both formats", async () => {
    const session = await createNewHwpDocumentSession();
    const reopened: ReturnType<typeof wrapHwpDocument>[] = [];
    try {
      const start = session.hitTest(0, 113, 132);
      const picturePosition = session.insertText(start, "그림 앞");
      const png = Uint8Array.from(
        atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6WQAAAAASUVORK5CYII="),
        (character) => character.charCodeAt(0),
      );
      session.insertPicture(picturePosition, png, "png", 1, 1, 7200, 7200);
      expect(session.renderPage(0)).toContain("<image");
      session.undo();
      expect(session.renderPage(0)).not.toContain("<image");
      session.redo();
      expect(session.renderPage(0)).toContain("<image");

      for (const format of ["hwp", "hwpx"] as const) {
        const saved = session.exportWithReport(format);
        expect(saved.report).toMatchObject({ outputFormat: format, count: 0 });
        const reopenedSession = wrapHwpDocument(new HwpDocument(saved.bytes));
        reopened.push(reopenedSession);
        expect(reopenedSession.searchText("그림 앞", false)).toHaveLength(1);
        expect(reopenedSession.renderPage(0)).toContain("<image");
      }
    } finally {
      reopened.forEach((document) => document.dispose());
      session.dispose();
    }
  });

  it("adds and removes a hyperlink through the document model and preserves it after reopen", async () => {
    const session = await createNewHwpDocumentSession();
    let reopened: ReturnType<typeof wrapHwpDocument> | null = null;
    try {
      const start = session.hitTest(0, 113, 132);
      const end = session.insertText(start, "링크");
      session.setHyperlink(start, end, "https://example.com");
      const saved = session.exportWithReport("hwpx");
      expect(saved.report).toMatchObject({ outputFormat: "hwpx", count: 0 });
      const reopenedDocument = new HwpDocument(saved.bytes);
      reopened = wrapHwpDocument(reopenedDocument);
      const context = JSON.parse(reopenedDocument.getHyperlinkContext(JSON.stringify({
        section: 0,
        para: 0,
        cellPath: [],
        start: 0,
        end: 2,
      }))) as { links: Array<{ uri: string; text: string }> };
      expect(context.links).toContainEqual(expect.objectContaining({ uri: "https://example.com", text: "링크" }));

      session.undo();
      const undone = session.exportWithReport("hwpx");
      const undoneDocument = new HwpDocument(undone.bytes);
      try {
        const undoneContext = JSON.parse(undoneDocument.getHyperlinkContext(JSON.stringify({ section: 0, para: 0, cellPath: [], start: 0, end: 2 }))) as { links: unknown[] };
        expect(undoneContext.links).toHaveLength(0);
      } finally {
        undoneDocument.free();
      }
      session.redo();
    } finally {
      reopened?.dispose();
      session.dispose();
    }
  });

  it("inserts page-number and footnote fields as undoable document controls", async () => {
    const document = HwpDocument.createEmpty();
    let session: ReturnType<typeof wrapHwpDocument> | null = null;
    const reopened: ReturnType<typeof wrapHwpDocument>[] = [];
    try {
      document.createBlankDocument();
      session = wrapHwpDocument(document);
      const start = session.hitTest(0, 113, 132);
      session.insertText(start, "주석이 있는 본문");
      session.insertAutoNumber(start, "page");
      const afterPageNumber = document.getControls();
      expect(afterPageNumber).not.toBe("[]");
      session.undo();
      session.redo();
      session.insertFootnote(start);
      const afterFootnote = document.getControls();
      expect(afterFootnote).not.toBe(afterPageNumber);
      session.undo();
      expect(document.getControls()).toBe(afterPageNumber);
      session.redo();

      for (const format of ["hwp", "hwpx"] as const) {
        const saved = session.exportWithReport(format);
        expect(saved.report).toMatchObject({ outputFormat: format, count: 0 });
        const reopenedDocument = new HwpDocument(saved.bytes);
        const reopenedSession = wrapHwpDocument(reopenedDocument);
        reopened.push(reopenedSession);
        expect(reopenedSession.searchText("주석이 있는 본문", false)).toHaveLength(1);
        expect(JSON.parse(reopenedDocument.getControls()).length).toBeGreaterThan(0);
      }
    } finally {
      reopened.forEach((item) => item.dispose());
      session?.dispose();
    }
  });
});
