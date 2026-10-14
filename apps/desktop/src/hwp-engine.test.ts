// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import init, { HwpDocument } from "@rhwp/core";
import { readFile } from "node:fs/promises";
import {
  createNewHwpDocumentSession,
  wrapHwpDocument,
  type TableCommand,
} from "./hwp-engine";
import type { DocumentObject, TextPosition } from "./document-engine";

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
  it("records edit command costs on a synthetic 35-page document", async () => {
    const fixture = HwpDocument.createEmpty();
    let fixtureBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let fixturePages = 0;
    try {
      fixture.createBlankDocument();
      fixture.insertText(0, 0, 0, ("Hanul 편집 지연 계측용 문단입니다. 0123456789 가나다라마바사아자차카타파하\n").repeat(1400));
      fixturePages = fixture.pageCount();
      const exportedFixture = fixture.exportHwpWithReport();
      try {
        fixtureBytes = exportedFixture.takeBytes();
      } finally {
        exportedFixture.free();
      }
    } finally {
      fixture.free();
    }

    const measurements: Array<Record<string, number | string>> = [];
    const measure = async (
      name: string,
      prepare: (session: ReturnType<typeof wrapHwpDocument>) => TextPosition,
      edit: (session: ReturnType<typeof wrapHwpDocument>, position: TextPosition) => void,
    ) => {
      const document = new HwpDocument(fixtureBytes);
      const session = wrapHwpDocument(document);
      const position = prepare(session);
      const snapshotTimes: number[] = [];
      const originalSaveSnapshot = document.saveSnapshot.bind(document);
      const saveSnapshotSpy = vi.spyOn(document, "saveSnapshot").mockImplementation(() => {
        const startedAt = performance.now();
        const id = originalSaveSnapshot();
        snapshotTimes.push(performance.now() - startedAt);
        return id;
      });
      try {
        const runtime = globalThis as typeof globalThis & { process?: { memoryUsage: () => { rss: number } } };
        const rssBeforeBytes = runtime.process?.memoryUsage().rss ?? 0;
        const startedAt = performance.now();
        edit(session, position);
        const editMs = performance.now() - startedAt;
        const rssAfterBytes = runtime.process?.memoryUsage().rss ?? 0;
        measurements.push({
          operation: name,
          editMs: Number(editMs.toFixed(2)),
          snapshotCount: snapshotTimes.length,
          snapshotMs: Number(snapshotTimes.reduce((sum, value) => sum + value, 0).toFixed(2)),
          rssBeforeBytes,
          rssAfterBytes,
        });
      } finally {
        saveSnapshotSpy.mockRestore();
        session.dispose();
      }
    };

    await measure("single-character-model-insert", (session) => session.hitTest(session.pageCount - 1, 113, 132),
      (session, position) => { session.insertText(position, "가"); });
    await measure("paragraph-format", (session) => session.hitTest(session.pageCount - 1, 113, 132),
      (session, position) => { session.applyParagraphAlignment(position, "center"); });
    await measure("table-row-insert", (session) => session.createTable(
      session.hitTest(session.pageCount - 1, 113, 132), 2, 2,
    ), (session, position) => { session.editTable(position, "insertRowBelow"); });
    let movingObject: DocumentObject | null = null;
    await measure("object-move-update", (session) => {
      const position = session.hitTest(session.pageCount - 1, 113, 132);
      session.insertShape(position, "rectangle", 25, 15);
      const objects = session.listObjects(position.sectionIndex);
      movingObject = objects[objects.length - 1] ?? null;
      return position;
    }, (session) => {
      if (!movingObject) throw new Error("Object fixture was not inserted");
      session.updateObject(movingObject, { offsetXmm: movingObject.offsetXmm + 1 });
    });
    console.info("HANUL_EDIT_COMMAND_PERF", JSON.stringify({
      syntheticParagraphs: 1400,
      pages: fixturePages,
      measurements,
    }));
  });

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

  it("measures a late-page edit and keeps the earlier page SVG cached", async () => {
    const document = HwpDocument.createEmpty();
    let session: ReturnType<typeof wrapHwpDocument> | null = null;
    try {
      document.createBlankDocument();
      document.insertText(0, 0, 0, ("Hanul 페이지 캐시 측정 문장입니다. 0123456789 가나다라마바사아자차카타파하\n").repeat(1400));
      session = wrapHwpDocument(document);
      const lastPage = session.pageCount - 1;
      expect(lastPage).toBeGreaterThan(12);
      const firstPageSvg = session.renderPage(0);
      const lastPagePosition = session.hitTest(lastPage, 113, 132);
      session.renderPage(lastPage);
      const renderSpy = vi.spyOn(document, "renderPageSvg");

      const editStartedAt = performance.now();
      session.insertText(lastPagePosition, "edit");
      const editAndReflowMs = performance.now() - editStartedAt;
      const unchangedStartedAt = performance.now();
      expect(session.renderPage(0)).toBe(firstPageSvg);
      const unchangedPageMs = performance.now() - unchangedStartedAt;
      const changedStartedAt = performance.now();
      const changedPageSvg = session.renderPage(lastPage);
      const changedPageSvgMs = performance.now() - changedStartedAt;

      expect(session.searchText("edit", true)).toHaveLength(1);
      expect(changedPageSvg).toContain(">e</text>");
      expect(renderSpy).toHaveBeenCalledTimes(1);
      console.info("HANUL_EDIT_PERF", JSON.stringify({
        syntheticParagraphs: 1400,
        pages: session.pageCount,
        editAndReflowMs: Number(editAndReflowMs.toFixed(2)),
        unchangedPageCacheLookupMs: Number(unchangedPageMs.toFixed(2)),
        changedPageSvgRegenerationMs: Number(changedPageSvgMs.toFixed(2)),
        regeneratedSvgCharacters: changedPageSvg.length,
        untouchedPageSvgCharacters: firstPageSvg.length,
      }));
    } finally {
      session?.dispose();
      if (!session) document.free();
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

  it("supports case-sensitive search and replacement with save, undo and redo", async () => {
    const session = await createNewHwpDocumentSession();
    const reopened: ReturnType<typeof wrapHwpDocument>[] = [];
    try {
      const start = session.hitTest(0, 113, 132);
      session.insertText(start, "Hanul hanul HANUL");
      expect(session.searchText("Hanul", { caseSensitive: false })).toHaveLength(3);
      expect(session.searchText("Hanul", { caseSensitive: true })).toHaveLength(1);

      const result = session.replaceAllText("Hanul", "한울", { caseSensitive: true });
      expect(result.count).toBe(1);
      expect(session.searchText("Hanul", { caseSensitive: true })).toHaveLength(0);
      expect(session.searchText("한울", { caseSensitive: true })).toHaveLength(1);
      session.undo();
      expect(session.searchText("Hanul", { caseSensitive: true })).toHaveLength(1);
      session.redo();
      expect(session.searchText("Hanul", { caseSensitive: true })).toHaveLength(0);

      for (const format of ["hwp", "hwpx"] as const) {
        const saved = session.exportWithReport(format);
        expect(saved.report).toMatchObject({ outputFormat: format, count: 0 });
        const reopenedSession = wrapHwpDocument(new HwpDocument(saved.bytes));
        reopened.push(reopenedSession);
        expect(reopenedSession.searchText("한울", { caseSensitive: true })).toHaveLength(1);
        expect(reopenedSession.searchText("hanul", { caseSensitive: true })).toHaveLength(1);
      }
    } finally {
      reopened.forEach((item) => item.dispose());
      session.dispose();
    }
  });

  it("edits rectangles and text boxes through the engine adapter and preserves them in HWP/HWPX", async () => {
    const session = await createNewHwpDocumentSession();
    const reopened: ReturnType<typeof wrapHwpDocument>[] = [];
    try {
      const start = session.hitTest(0, 113, 132);
      session.insertShape(start, "rectangle", 30, 15);
      let objects = session.listObjects(0);
      expect(objects).toHaveLength(1);
      expect(objects[0]).toMatchObject({ kind: "rectangle", widthMm: 30, heightMm: 15 });
      expect(objects[0]!.bounds.width).toBeCloseTo(30 * 96 / 25.4, 1);
      const rectangle = objects[0]!;
      session.updateObject(rectangle, {
        widthMm: 45,
        heightMm: 22,
        offsetXmm: rectangle.offsetXmm + 12,
        offsetYmm: rectangle.offsetYmm + 9,
        textWrap: "TopAndBottom",
      });
      objects = session.listObjects(0);
      expect(objects[0]!.widthMm).toBeCloseTo(45, 2);
      expect(objects[0]!.heightMm).toBeCloseTo(22, 2);
      expect(objects[0]!.textWrap).toBe("TopAndBottom");
      session.undo();
      expect(session.listObjects(0)[0]!.widthMm).toBeCloseTo(30, 2);
      expect(session.listObjects(0)[0]!.heightMm).toBeCloseTo(15, 2);
      session.redo();
      expect(session.listObjects(0)[0]!.widthMm).toBeCloseTo(45, 2);
      expect(session.listObjects(0)[0]!.heightMm).toBeCloseTo(22, 2);

      session.insertShape(start, "textBox", 36, 18);
      const textBox = session.listObjects(0).find((object) => object.kind === "textBox");
      expect(textBox).toBeDefined();
      const textPosition = session.hitTest(0, textBox!.bounds.x + 4, textBox!.bounds.y + 4);
      expect(textPosition.cellPath?.length).toBeGreaterThan(0);
      session.insertText(textPosition, "글상자 편집");
      expect(session.searchText("글상자 편집", true)).toHaveLength(1);
      session.undo();
      expect(session.searchText("글상자 편집", true)).toHaveLength(0);
      session.redo();

      const selected = session.listObjects(0).find((object) => object.kind === "textBox")!;
      session.deleteObject(selected);
      expect(session.listObjects(0).some((object) => object.kind === "textBox")).toBe(false);
      session.undo();
      expect(session.listObjects(0).some((object) => object.kind === "textBox")).toBe(true);
      session.redo();
      expect(session.listObjects(0).some((object) => object.kind === "textBox")).toBe(false);
      session.undo();
      expect(session.searchText("글상자 편집", true)).toHaveLength(1);

      for (const format of ["hwp", "hwpx"] as const) {
        const saved = session.exportWithReport(format);
        expect(saved.report).toMatchObject({ outputFormat: format, count: 0 });
        const reopenedSession = wrapHwpDocument(new HwpDocument(saved.bytes));
        reopened.push(reopenedSession);
        expect(reopenedSession.listObjects(0)).toHaveLength(2);
        expect(reopenedSession.listObjects(0)[0]).toMatchObject({ kind: "rectangle" });
        expect(reopenedSession.listObjects(0)[0]!.widthMm).toBeCloseTo(45, 2);
        expect(reopenedSession.listObjects(0)[0]!.heightMm).toBeCloseTo(22, 2);
        expect(reopenedSession.searchText("글상자 편집", true)).toHaveLength(1);
      }
    } finally {
      reopened.forEach((item) => item.dispose());
      session.dispose();
    }
  });

  it("edits page-scoped headers and footers with page fields through HWP/HWPX round trips", async () => {
    const session = await createNewHwpDocumentSession();
    const reopened: ReturnType<typeof wrapHwpDocument>[] = [];
    try {
      const start = session.hitTest(0, 113, 132);
      expect(session.headerFooterInfo(start, "header", "bothPages")).toMatchObject({ exists: false, applyTo: 0 });
      expect(session.headerFooterInfo(start, "header", "currentPage")).toMatchObject({ sectionIndex: 0, applyTo: 0 });
      expect(session.headerFooterInfo(start, "header", "evenPages").applyTo).toBe(1);
      session.setHeaderFooterText(start, "header", "oddPages", "홀수 쪽 머리말");
      expect(session.headerFooterInfo(start, "header", "oddPages")).toMatchObject({ exists: true, applyTo: 2, text: "홀수 쪽 머리말" });
      session.setHeaderFooterText(start, "header", "oddPages", "수정한 홀수 쪽 머리말");
      expect(session.headerFooterInfo(start, "header", "oddPages").text).toBe("수정한 홀수 쪽 머리말");
      session.undo();
      expect(session.headerFooterInfo(start, "header", "oddPages").text).toBe("홀수 쪽 머리말");
      session.redo();

      for (const format of ["hwp", "hwpx"] as const) {
        const saved = session.exportWithReport(format);
        expect(saved.report).toMatchObject({ outputFormat: format, count: 0 });
        const reopenedSession = wrapHwpDocument(new HwpDocument(saved.bytes));
        reopened.push(reopenedSession);
        expect(reopenedSession.headerFooterInfo(start, "header", "oddPages").text).toBe("수정한 홀수 쪽 머리말");
      }

      session.insertHeaderFooterField(start, "header", "oddPages", "pageNumber");
      expect(session.headerFooterInfo(start, "header", "oddPages").text).toContain("\u0015");
      session.undo();
      expect(session.headerFooterInfo(start, "header", "oddPages").text).toBe("수정한 홀수 쪽 머리말");
      session.redo();
      session.insertHeaderFooterField(start, "header", "oddPages", "totalPages");
      session.insertHeaderFooterField(start, "header", "oddPages", "fileName");
      expect(session.headerFooterInfo(start, "header", "oddPages").text).toContain("\u0016");
      expect(session.headerFooterInfo(start, "header", "oddPages").text).toContain("\u0017");

      for (const format of ["hwp", "hwpx"] as const) {
        const saved = session.exportWithReport(format);
        expect(saved.report.outputFormat).toBe(format);
        expect(saved.report.count).toBeGreaterThanOrEqual(3);
        expect(saved.report.losses).toContainEqual(expect.objectContaining({
          code: "header-footer-field-roundtrip",
          subject: "머리말 쪽 번호",
          reason: expect.stringContaining("U+0015"),
          message: expect.stringContaining("1번째 문단"),
        }));
        expect(saved.report.losses).toContainEqual(expect.objectContaining({
          code: "header-footer-field-roundtrip",
          subject: "머리말 전체 쪽 수",
        }));
        expect(saved.report.losses).toContainEqual(expect.objectContaining({
          code: "header-footer-field-roundtrip",
          subject: "머리말 파일 이름",
        }));
        const reopenedSession = wrapHwpDocument(new HwpDocument(saved.bytes));
        reopened.push(reopenedSession);
        expect(reopenedSession.headerFooterInfo(start, "header", "oddPages").text).toContain("수정한 홀수 쪽 머리말");
        expect(reopenedSession.headerFooterInfo(start, "header", "oddPages").text).not.toContain("\u0015");
        expect(reopenedSession.headerFooterInfo(start, "header", "oddPages").text).not.toContain("\u0016");
        expect(reopenedSession.headerFooterInfo(start, "header", "oddPages").text).not.toContain("\u0017");
      }

      session.deleteHeaderFooter(start, "header", "oddPages");
      expect(session.headerFooterInfo(start, "header", "oddPages").exists).toBe(false);
      session.undo();
      expect(session.headerFooterInfo(start, "header", "oddPages").text).toContain("\u0015");
      session.redo();
      expect(session.headerFooterInfo(start, "header", "oddPages").exists).toBe(false);
    } finally {
      reopened.forEach((item) => item.dispose());
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
      expect(originalPage.width).toBeCloseTo(210, 0);
      expect(originalPage.height).toBeCloseTo(297, 0);
      const changedPage = session.setPageDefinition(start, {
        marginLeft: originalPage.marginLeft + 4,
        marginRight: originalPage.marginRight + 4,
        landscape: true,
      });
      expect(session.pageDefinition(0).marginLeft).toBeCloseTo(originalPage.marginLeft + 4, 2);
      expect(session.pageDefinition(0).marginRight).toBeCloseTo(originalPage.marginRight + 4, 2);
      expect(session.pageDefinition(0).landscape).toBe(true);
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
        expect(reopenedSession.pageDefinition(0).marginLeft).toBeCloseTo(originalPage.marginLeft + 4, 2);
        expect(reopenedSession.pageDefinition(0).marginRight).toBeCloseTo(originalPage.marginRight + 4, 2);
        expect(reopenedSession.pageDefinition(0).landscape).toBe(true);
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
      session.insertPicture(picturePosition, png, "png", 1, 1, 25.4, 25.4);
      expect(session.renderPage(0)).toContain("<image");
      session.undo();
      expect(session.renderPage(0)).not.toContain("<image");
      session.redo();
      expect(session.renderPage(0)).toContain("<image");

      const picture = session.listObjects(0).find((object) => object.kind === "picture");
      expect(picture).toBeDefined();
      session.updateObject(picture!, { widthMm: 38.1, heightMm: 19.05, offsetXmm: 1500 / (7200 / 25.4), offsetYmm: 900 / (7200 / 25.4), textWrap: "TopAndBottom" });
      expect(session.listObjects(0)[0]).toMatchObject({ widthMm: 38.1, heightMm: 19.05, textWrap: "TopAndBottom" });
      session.undo();
      expect(session.listObjects(0)[0]).toMatchObject({ widthMm: 25.4, heightMm: 25.4 });
      session.redo();
      const resizedPicture = session.listObjects(0).find((object) => object.kind === "picture")!;
      session.deleteObject(resizedPicture);
      expect(session.listObjects(0)).toHaveLength(0);
      session.undo();
      expect(session.listObjects(0)).toHaveLength(1);
      session.redo();
      expect(session.listObjects(0)).toHaveLength(0);
      session.undo();

      for (const format of ["hwp", "hwpx"] as const) {
        const saved = session.exportWithReport(format);
        expect(saved.report).toMatchObject({ outputFormat: format, count: 0 });
        const reopenedSession = wrapHwpDocument(new HwpDocument(saved.bytes));
        reopened.push(reopenedSession);
        expect(reopenedSession.searchText("그림 앞", false)).toHaveLength(1);
        expect(reopenedSession.renderPage(0)).toContain("<image");
        expect(reopenedSession.listObjects(0)).toMatchObject([expect.objectContaining({ kind: "picture", widthMm: 38.1, heightMm: 19.05 })]);
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
