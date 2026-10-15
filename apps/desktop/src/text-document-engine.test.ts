import { describe, expect, it } from "vitest";
import { ImeInputGate } from "./ime-input";
import { createInMemoryTextSession, plainTextCompatibilityReport } from "./text-document-engine";

const LINES_PER_PAGE = 44;
const syntheticParagraph = (index: number) => `한글 문서 편집 조판 성능과 문단별 증분 배치를 검증합니다. ${String(index).padStart(4, "0")}`;

describe("Hanul paragraph text engine", () => {
  it("returns format-specific compatibility reasons for textbox structures", () => {
    const session = createInMemoryTextSession([{ text: "본문" }]);
    try {
      const anchor = session.hitTest(0, 100, 100);
      session.insertShape(anchor, "textBox", 50, 24);
      const textbox = session.listObjects(0).find((object) => object.kind === "textBox")!;
      session.updateObject(textbox, { widthMm: 63, heightMm: 31, offsetXmm: 12, offsetYmm: 15 });
      expect(session.compatibilityReport("hwp")).toMatchObject({
        schemaVersion: 2,
        engine: "hanul-text",
        validator: "hanul-policy",
        status: "SUPPORTED",
        format: "hwp",
        supported: true,
        structure: { sectionCount: 1, objectCounts: { textBox: 1 }, textBoxParagraphCounts: [1] },
        issues: [],
      });
      expect(session.compatibilityReport("hwpx")).toMatchObject({ format: "hwpx", supported: true });

      const multipleParagraphs = session.paragraphs();
      multipleParagraphs[0]!.objects![0]!.textParagraphs = [
        { text: "첫 문단", pageBreakBefore: false, paragraphFormat: {}, characterFormats: [] },
        { text: "둘째 문단", pageBreakBefore: false, paragraphFormat: {}, characterFormats: [] },
      ];
      const multipleParagraphSession = createInMemoryTextSession(multipleParagraphs);
      expect(multipleParagraphSession.compatibilityReport("hwp")).toMatchObject({
        supported: false,
        issues: [{ code: "hwp.textbox.paragraph_count", feature: "textBox" }],
      });
      expect(multipleParagraphSession.compatibilityReport("hwpx")).toMatchObject({
        format: "hwpx",
        status: "UNKNOWN",
        supported: false,
        issues: [{ code: "hwpx.textbox.unverified_structure", affectedElements: [{ kind: "textBox", count: 1 }] }],
      });
      multipleParagraphSession.dispose();

      const multipleBoxes = session.paragraphs();
      multipleBoxes[0]!.objects!.push({ ...multipleBoxes[0]!.objects![0]!, id: "second-box", controlIndex: 2002 });
      const multipleBoxesSession = createInMemoryTextSession(multipleBoxes);
      expect(multipleBoxesSession.compatibilityReport("hwp")).toMatchObject({
        supported: false,
        issues: [{ code: "hwp.textbox.count" }],
      });
      expect(multipleBoxesSession.compatibilityReport("hwpx")).toMatchObject({
        status: "UNKNOWN",
        supported: false,
        issues: [{ code: "hwpx.textbox.unverified_structure" }],
      });
      multipleBoxesSession.dispose();

      const tableAndTextbox = session.paragraphs();
      tableAndTextbox.push({
        text: "",
        pageBreakBefore: false,
        paragraphFormat: {},
        characterFormats: [],
        table: {
          rowCount: 1,
          colCount: 1,
          columnWidthsMm: [50],
          properties: {},
          cells: [{
            row: 0,
            col: 0,
            rowSpan: 1,
            colSpan: 1,
            widthMm: 50,
            heightMm: 10,
            properties: {},
            paragraphs: [{ text: "셀", pageBreakBefore: false, paragraphFormat: {}, characterFormats: [] }],
          }],
        },
      });
      const tableSession = createInMemoryTextSession(tableAndTextbox);
      expect(tableSession.compatibilityReport("hwp")).toMatchObject({
        supported: false,
        issues: [{ code: "hwp.textbox.mixed_content" }],
      });
      tableSession.dispose();

      const pictureAndTextbox = session.paragraphs();
      pictureAndTextbox[0]!.objects!.push({ ...pictureAndTextbox[0]!.objects![0]!, id: "picture", kind: "picture" });
      const pictureSession = createInMemoryTextSession(pictureAndTextbox);
      expect(pictureSession.compatibilityReport("hwp")).toMatchObject({
        supported: false,
        issues: [{ code: "hwp.textbox.mixed_content" }],
      });
      pictureSession.dispose();

      const transformedTextbox = session.paragraphs();
      transformedTextbox[0]!.objects![0]!.properties.rotationAngle = 15;
      const transformedSession = createInMemoryTextSession(transformedTextbox);
      expect(transformedSession.compatibilityReport("hwp")).toMatchObject({
        supported: false,
        issues: [{ code: "hwp.textbox.unsupported_shape" }],
      });
      transformedSession.dispose();

      const nestedTextbox = session.paragraphs();
      const innerParagraph = nestedTextbox[0]!.objects![0]!.textParagraphs![0]! as unknown as { objects?: unknown[] };
      innerParagraph.objects = [{ kind: "picture" }];
      expect(plainTextCompatibilityReport(nestedTextbox, "hwp")).toMatchObject({
        supported: false,
        issues: [{ code: "hwp.textbox.nested_content" }],
      });

      const fieldTextbox = session.paragraphs();
      fieldTextbox[0]!.objects![0]!.textParagraphs![0]!.text = "필드\u0013내용";
      const fieldSession = createInMemoryTextSession(fieldTextbox);
      expect(fieldSession.compatibilityReport("hwp")).toMatchObject({
        supported: false,
        issues: [{ code: "hwp.textbox.fields_or_ranges" }],
      });
      fieldSession.dispose();
    } finally {
      session.dispose();
    }
  });

  it.each([1, 35, 98, 500])("edits a %i-page model at the beginning, middle and end", (pageCount) => {
    const started = performance.now();
    const rssBefore = readRssBytes();
    const session = createInMemoryTextSession(Array.from({ length: pageCount * LINES_PER_PAGE }, (_, index) => ({ text: syntheticParagraph(index) })));
    const constructionMs = performance.now() - started;
    const rssAfterCreate = readRssBytes();
    expect(session.pageCount).toBe(pageCount);

    const samples: Array<Record<string, string | number>> = [];
    for (const [location, page] of [["beginning", 0], ["middle", Math.floor(pageCount / 2)], ["end", pageCount - 1]] as const) {
      const line = session.displayList(page).lines[0];
      const start = session.hitTest(page, line.x + 1, line.y);
      const position = location === "end" ? session.moveCaretToParagraphEdge(start, "end") : start;
      const before = performance.now();
      const next = session.insertText(position, "가");
      const afterEdit = performance.now();
      const svg = session.renderPage(page);
      const afterRender = performance.now();
      const metrics = session.metrics;
      samples.push({ location, modelMs: metrics.modelMutationMs, layoutMs: metrics.incrementalLayoutMs, renderMs: metrics.renderedPageMs, editToSvgMs: afterRender - before, synchronousUiBlockMs: afterRender - before, paragraphs: metrics.invalidatedParagraphs, pages: metrics.invalidatedPages, svgCharacters: svg.length });
      expect(session.selectedText(session.moveCaret(next, -1), next)).toBe("가");
      expect(metrics.invalidatedParagraphs).toBe(1);
      expect(metrics.invalidatedPages).toBe(1);
      expect(afterEdit - before).toBeLessThan(100);
      expect(session.undo()).not.toBeNull();
      expect(session.redo()).not.toBeNull();
    }

    console.info("HANUL_TEXT_ENGINE_BENCH", JSON.stringify({ pageCount, constructionMs: Number(constructionMs.toFixed(2)), rssBeforeBytes: rssBefore, rssAfterCreateBytes: rssAfterCreate, rssAfterEditsBytes: readRssBytes(), measurements: "Node engine sync timings; editToSvg excludes React DOM commit and physical display", edits: samples }));
    session.dispose();
  }, 120_000);

  it.each([1, 35, 98, 500])("measures cell editing and row insertion in a %i-page model", (pageCount) => {
    const rssBeforeBytes = readRssBytes();
    const constructionStarted = performance.now();
    const session = createInMemoryTextSession(Array.from({ length: pageCount * LINES_PER_PAGE }, (_, index) => ({ text: syntheticParagraph(index) })));
    const constructionMs = performance.now() - constructionStarted;
    const rssAfterCreateBytes = readRssBytes();
    const anchorLine = session.displayList(pageCount - 1).lines[0];
    const anchor = session.hitTest(pageCount - 1, anchorLine.x + 1, anchorLine.y);
    const createStarted = performance.now();
    const tableCaret = session.createTable(anchor, 2, 2);
    const createTableMs = performance.now() - createStarted;
    const editStarted = performance.now();
    const editedCaret = session.insertText(tableCaret, "가");
    const afterEdit = performance.now();
    const svg = session.renderPage(editedCaret.cursorRect.pageIndex);
    const afterSvg = performance.now();
    const cellMetrics = { ...session.metrics };
    expect(session.searchText("가")).toHaveLength(1);
    expect(svg).toContain("가");
    expect(cellMetrics.invalidatedParagraphs).toBe(1);
    expect(cellMetrics.invalidatedPages).toBe(1);

    const rowStarted = performance.now();
    session.editTable(editedCaret, "insertRowBelow");
    const afterRowEdit = performance.now();
    session.renderPage(editedCaret.cursorRect.pageIndex);
    const afterRowSvg = performance.now();
    const rowMetrics = { ...session.metrics };
    const table = session.paragraphs().find((paragraph) => paragraph.table)?.table;
    expect(table?.rowCount).toBe(3);
    const runtime = globalThis as typeof globalThis & { process?: { platform?: string; version?: string } };

    console.info("HANUL_TABLE_ENGINE_BENCH", JSON.stringify({
      platform: runtime.process?.platform ?? "unknown",
      node: runtime.process?.version ?? "unknown",
      pages: pageCount,
      paragraphs: pageCount * LINES_PER_PAGE,
      constructionMs,
      rssBeforeBytes,
      rssAfterCreateBytes,
      createTableMs,
      cell: {
        modelAndLayoutMs: afterEdit - editStarted,
        modelMutationMs: cellMetrics.modelMutationMs,
        incrementalLayoutMs: cellMetrics.incrementalLayoutMs,
        svgMs: cellMetrics.renderedPageMs,
        editToSvgMs: afterSvg - editStarted,
        invalidatedParagraphs: cellMetrics.invalidatedParagraphs,
        invalidatedPages: cellMetrics.invalidatedPages,
      },
      insertRow: {
        modelAndLayoutMs: afterRowEdit - rowStarted,
        incrementalLayoutMs: rowMetrics.incrementalLayoutMs,
        svgMs: rowMetrics.renderedPageMs,
        editToSvgMs: afterRowSvg - rowStarted,
        invalidatedParagraphs: rowMetrics.invalidatedParagraphs,
        invalidatedPages: rowMetrics.invalidatedPages,
      },
    }));
    session.dispose();
  }, 120_000);

  it("coalesces continuous typing and restores the exact text through undo/redo", () => {
    const session = createInMemoryTextSession([{ text: "start" }]);
    let caret = session.moveCaretToParagraphEdge(session.hitTest(0, 95, 110), "end");
    for (const character of ["가", "나", "다", "라"]) caret = session.insertText(caret, character);
    expect(session.paragraphs()[0].text).toBe("start가나다라");
    session.undo();
    expect(session.paragraphs()[0].text).toBe("start");
    const redoCaret = session.redo();
    expect(session.paragraphs()[0].text).toBe("start가나다라");
    expect(redoCaret?.charOffset).toBe("start가나다라".length);
    session.dispose();
  });

  it.each([35, 98, 500])("measures independent shape insert and move in a synthetic %i-page document", (pageCount) => {
    const rssBeforeBytes = readRssBytes();
    const session = createInMemoryTextSession(Array.from({ length: pageCount * LINES_PER_PAGE }, (_, index) => ({ text: syntheticParagraph(index) })));
    const rssAfterCreateBytes = readRssBytes();
    const line = session.displayList(0).lines.find((item) => item.cellIndex === undefined && item.objectControlIndex === undefined);
    expect(line).toBeDefined();
    const anchor = session.hitTest(0, line!.x + 1, line!.y);

    const insertStartedAt = performance.now();
    session.insertShape(anchor, "rectangle", 40, 24);
    const insertCompletedAt = performance.now();
    const insertMetrics = { ...session.metrics };
    const insertSvg = session.renderPage(0);
    const insertRenderMetrics = { ...session.metrics };
    const insertRenderedAt = performance.now();
    const shape = session.listObjects(0).find((object) => object.kind === "rectangle");
    expect(shape).toBeDefined();

    const moveStartedAt = performance.now();
    session.updateObject(shape!, { offsetXmm: shape!.offsetXmm + 2, offsetYmm: shape!.offsetYmm + 1 });
    const moveCompletedAt = performance.now();
    const moveMetrics = { ...session.metrics };
    const movedSvg = session.renderPage(0);
    const moveRenderMetrics = { ...session.metrics };
    const moveRenderedAt = performance.now();
    expect(insertSvg).toContain("<rect");
    expect(movedSvg).toContain("<rect");
    expect(insertMetrics.invalidatedPages).toBe(1);
    expect(moveMetrics.invalidatedPages).toBe(1);

    console.log("HANUL_OBJECT_ENGINE_BENCH", JSON.stringify({
      platform: (globalThis as typeof globalThis & { process?: { platform?: string; version?: string } }).process?.platform ?? "browser-like",
      runtime: (globalThis as typeof globalThis & { process?: { version?: string } }).process?.version ?? "unknown",
      pageCount,
      paragraphs: pageCount * LINES_PER_PAGE,
      modelRssDeltaBytes: rssBeforeBytes !== null && rssAfterCreateBytes !== null ? rssAfterCreateBytes - rssBeforeBytes : null,
      insert: {
        modelMutationMs: insertMetrics.modelMutationMs,
        incrementalLayoutMs: insertMetrics.incrementalLayoutMs,
        svgMs: insertRenderMetrics.renderedPageMs,
        modelToSvgMs: insertRenderedAt - insertStartedAt,
        layoutElapsedMs: insertCompletedAt - insertStartedAt,
        invalidatedParagraphs: insertMetrics.invalidatedParagraphs,
        invalidatedPages: insertMetrics.invalidatedPages,
        svgCharacters: insertSvg.length,
      },
      move: {
        modelMutationMs: moveMetrics.modelMutationMs,
        incrementalLayoutMs: moveMetrics.incrementalLayoutMs,
        svgMs: moveRenderMetrics.renderedPageMs,
        modelToSvgMs: moveRenderedAt - moveStartedAt,
        layoutElapsedMs: moveCompletedAt - moveStartedAt,
        invalidatedParagraphs: moveMetrics.invalidatedParagraphs,
        invalidatedPages: moveMetrics.invalidatedPages,
        svgCharacters: movedSvg.length,
      },
      measurementScope: "synthetic engine/model/layout/SVG only; excludes React commit and physical UI frame time",
    }));
    expect(session.undo()).not.toBeNull();
    expect(session.listObjects(0)[0]?.offsetXmm).toBeCloseTo(shape!.offsetXmm, 2);
    expect(session.redo()).not.toBeNull();
    expect(session.listObjects(0)[0]?.offsetXmm).toBeCloseTo(shape!.offsetXmm + 2, 2);
    session.dispose();
  });

  it("deletes across paragraph boundaries and supports undo/redo", () => {
    const session = createInMemoryTextSession([{ text: "앞 문단" }, { text: "가운데" }, { text: "뒤 문단" }]);
    const firstLine = session.displayList(0).lines[0];
    const start = session.moveCaretToParagraphEdge(session.hitTest(0, firstLine.x, firstLine.y), "end");
    const lastParagraphStart = { ...start, paragraphIndex: 2, charOffset: 0 };
    const end = session.moveCaretToParagraphEdge(lastParagraphStart, "start");
    session.deleteRange(start, end);
    expect(session.paragraphs().map((paragraph) => paragraph.text)).toEqual(["앞 문단뒤 문단"]);
    session.undo();
    expect(session.paragraphs().map((paragraph) => paragraph.text)).toEqual(["앞 문단", "가운데", "뒤 문단"]);
    session.redo();
    expect(session.paragraphs().map((paragraph) => paragraph.text)).toEqual(["앞 문단뒤 문단"]);
    session.dispose();
  });

  it("moves the caret by a visual text line instead of jumping a whole page", () => {
    const session = createInMemoryTextSession([{ text: "첫째 줄" }, { text: "둘째 줄" }, { text: "셋째 줄" }]);
    const first = session.displayList(0).lines[0];
    const caret = session.hitTest(0, first.x, first.y);
    expect(session.moveCaretVertical(caret, 1).paragraphIndex).toBe(1);
    session.dispose();
  });

  it("renders justified imported paragraphs with matching caret and selection geometry", () => {
    const session = createInMemoryTextSession([{ text: "한글 조판 문장을 여러 줄로 늘려 정렬 간격을 확인합니다. ".repeat(8), paragraphFormat: { alignment: "justify" } }]);
    const page = session.displayList(0);
    expect(page.lines.length).toBeGreaterThan(1);
    expect(page.lines[0].textLength).toBeGreaterThan(0);
    expect(session.renderPage(0)).toContain("lengthAdjust=\"spacing\"");
    const first = page.lines[0];
    const hit = session.hitTest(0, first.x + first.textLength! - 2, first.y);
    expect(hit.paragraphIndex).toBe(0);
    expect(hit.charOffset).toBeGreaterThan(0);
    const selection = session.selectionRectangles({ ...hit, charOffset: 0 }, hit);
    expect(selection[0].x + selection[0].width).toBeGreaterThan(first.x);
    session.dispose();
  });

  it("finds and replaces all matches as one undoable document transaction", () => {
    const session = createInMemoryTextSession([{ text: "Hanul hanul HANUL" }, { text: "Hanul" }]);
    const result = session.replaceAllText("hanul", "문서", { caseSensitive: false });
    expect(result.count).toBe(4);
    expect(session.paragraphs().map((paragraph) => paragraph.text)).toEqual(["문서 문서 문서", "문서"]);
    session.undo();
    expect(session.paragraphs().map((paragraph) => paragraph.text)).toEqual(["Hanul hanul HANUL", "Hanul"]);
    session.redo();
    expect(session.paragraphs().map((paragraph) => paragraph.text)).toEqual(["문서 문서 문서", "문서"]);
    session.dispose();
  });

  it("treats a hard page break as one undoable edit", () => {
    const session = createInMemoryTextSession([{ text: "앞뒤 문장" }]);
    const firstLine = session.displayList(0).lines[0];
    const start = session.hitTest(0, firstLine.x, firstLine.y);
    const middle = { ...start, charOffset: 1 };
    session.insertPageBreak(middle);
    expect(session.pageCount).toBe(2);
    expect(session.paragraphs().map((paragraph) => paragraph.text)).toEqual(["앞", "뒤 문장"]);
    expectLayoutMatchesFullReflow(session);
    session.undo();
    expect(session.pageCount).toBe(1);
    expect(session.paragraphs().map((paragraph) => paragraph.text)).toEqual(["앞뒤 문장"]);
    expectLayoutMatchesFullReflow(session);
    session.redo();
    expect(session.pageCount).toBe(2);
    expect(session.paragraphs().map((paragraph) => paragraph.text)).toEqual(["앞", "뒤 문장"]);
    expectLayoutMatchesFullReflow(session);
    session.dispose();
  });

  it("repaginates only to a stable flow point when a paragraph crosses a page boundary", () => {
    const session = createInMemoryTextSession(Array.from({ length: LINES_PER_PAGE }, (_, index) => ({ text: `line-${index}` })));
    expect(session.pageCount).toBe(1);
    const first = session.hitTest(0, 95, 110);
    session.insertText(first, "가".repeat(80));
    expect(session.pageCount).toBe(2);
    expect(session.metrics.invalidatedParagraphs).toBeGreaterThan(1);
    expectLayoutMatchesFullReflow(session);
    expect(session.undo()).not.toBeNull();
    expect(session.pageCount).toBe(1);
    expectLayoutMatchesFullReflow(session);
    expect(session.redo()).not.toBeNull();
    expect(session.pageCount).toBe(2);
    expectLayoutMatchesFullReflow(session);
    session.dispose();
  });

  it("commits one Korean IME result to the model and suppresses the duplicate echo", () => {
    const session = createInMemoryTextSession();
    const gate = new ImeInputGate();
    const caret = session.hitTest(0, 95, 110);
    gate.startComposition();
    gate.updateComposition("가");
    const committed = gate.finishComposition("가", 100);
    expect(committed).toBe("가");
    const next = session.insertText(caret, committed!);
    expect(gate.acceptInput("가", { inputType: "insertFromComposition" }, 101)).toBeNull();
    expect(session.selectedText(caret, next)).toBe("가");
    session.undo();
    expect(session.paragraphs()[0].text).toBe("");
    session.redo();
    expect(session.paragraphs()[0].text).toBe("가");
    session.dispose();
  });

  it("edits table cells in the document model with cell-local incremental layout and undo", () => {
    const session = createInMemoryTextSession([{ text: "표 앞 문단" }, { text: "표 뒤 문단" }]);
    const anchor = session.moveCaretToParagraphEdge(session.hitTest(0, 95, 110), "end");
    let caret = session.createTable(anchor, 2, 2);
    expect(caret.cellPath?.[0].cellIndex).toBe(0);
    caret = session.insertText(caret, "셀 1");
    const secondCell = session.moveTableCell(caret, 1);
    session.insertText(secondCell, "셀 2");
    expect(session.searchText("셀 1")[0].start.cellPath?.[0].cellIndex).toBe(0);
    expect(session.searchText("셀 2")[0].start.cellPath?.[0].cellIndex).toBe(1);
    expect(session.metrics.invalidatedParagraphs).toBe(1);
    expect(session.renderPage(0)).toContain("셀 1");

    session.updateTable(session.searchText("셀 1")[0].start, {
      widthMm: 130,
      offsetXmm: 3,
      offsetYmm: 2,
      horizontalAlignment: "Center",
      rowHeightMm: 11,
      cellPaddingMm: 1.25,
      cellFillColor: "#fff2cc",
      borderColor: "#aa2200",
    });
    const tableLayout = session.tableLayout(session.searchText("셀 1")[0].start);
    expect(tableLayout.widthMm).toBeCloseTo(130, 1);
    expect(tableLayout.offsetXmm).toBeCloseTo(3, 1);
    expect(tableLayout.offsetYmm).toBeCloseTo(2, 1);
    expect(tableLayout).toMatchObject({ horizontalAlignment: "Center", rowHeightMm: 11, cellFillColor: "#fff2cc", cellBorderColor: "#aa2200" });
    expect(session.renderPage(0)).toContain("#fff2cc");
    session.undo();
    expect(session.tableLayout(session.searchText("셀 1")[0].start).widthMm).not.toBe(130);
    session.redo();
    expect(session.tableLayout(session.searchText("셀 1")[0].start).widthMm).toBe(130);

    const firstCell = session.searchText("셀 1")[0].start;
    session.editTable(firstCell, "mergeRight");
    expect(session.searchText("셀 2")[0].start.cellPath?.[0].cellIndex).toBe(0);
    session.undo();
    expect(session.searchText("셀 2")[0].start.cellPath?.[0].cellIndex).toBe(1);
    session.redo();
    expect(session.searchText("셀 2")[0].start.cellPath?.[0].cellIndex).toBe(0);
    session.editTable(session.searchText("셀 1")[0].start, "splitCell");
    expect(session.paragraphs().find((paragraph) => paragraph.table)?.table?.cells.find((entry) => entry.row === 0 && entry.col === 0)?.colSpan).toBe(1);
    session.undo();
    expect(session.paragraphs().find((paragraph) => paragraph.table)?.table?.cells.find((entry) => entry.row === 0 && entry.col === 0)?.colSpan).toBe(2);
    session.redo();
    session.editTable(session.searchText("셀 1")[0].start, "insertRowBelow");
    expect(session.paragraphs().find((paragraph) => paragraph.table)?.table?.rowCount).toBe(3);
    session.undo();
    expect(session.paragraphs().find((paragraph) => paragraph.table)?.table?.rowCount).toBe(2);
    session.redo();
    const widthBeforeColumnInsert = session.tableLayout(session.searchText("셀 1")[0].start).widthMm;
    session.editTable(session.searchText("셀 1")[0].start, "insertColumnRight");
    expect(session.paragraphs().find((paragraph) => paragraph.table)?.table?.colCount).toBe(3);
    expect(session.tableLayout(session.searchText("셀 1")[0].start).widthMm).toBeCloseTo(widthBeforeColumnInsert, 1);
    session.undo();
    expect(session.paragraphs().find((paragraph) => paragraph.table)?.table?.colCount).toBe(2);
    expectLayoutMatchesFullReflow(session);
    session.dispose();
  });

  it("keeps an explicitly selected column width inside the requested total table width", () => {
    const session = createInMemoryTextSession();
    const cell = session.createTable(session.hitTest(0, 95, 110), 2, 2);
    session.updateTable(cell, { widthMm: 150, columnWidthMm: 60 });
    expect(session.tableLayout(cell).widthMm).toBeCloseTo(150, 1);
    expect(session.tableLayout(cell).columnWidthMm).toBeCloseTo(60, 1);
    session.undo();
    expect(session.tableLayout(cell).widthMm).toBeCloseTo(160, 1);
    session.redo();
    expect(session.tableLayout(cell).widthMm).toBeCloseTo(150, 1);
    expect(session.tableLayout(cell).columnWidthMm).toBeCloseTo(60, 1);
    session.dispose();
  });

  it("flows and edits a table row that spans multiple pages", () => {
    const session = createInMemoryTextSession();
    const anchor = session.hitTest(0, 95, 110);
    const cell = session.createTable(anchor, 1, 1);
    const originalText = "페이지 경계를 넘는 표 셀 문장입니다. ".repeat(300);
    session.insertText(cell, originalText);
    expect(session.paragraphs().find((paragraph) => paragraph.table)?.table?.cells[0].paragraphs[0].text.length).toBe(originalText.length);
    expect(session.pageCount).toBeGreaterThan(1);
    const tablePages = Array.from({ length: session.pageCount }, (_, page) => page)
      .filter((page) => session.displayList(page).tables.some((table) => table.cells.some((entry) => entry.cellIndex === 0)));
    expect(tablePages.length).toBeGreaterThan(1);
    for (const page of tablePages) expect(session.renderPage(page)).toContain("<rect");

    const laterPage = tablePages[1];
    const line = session.displayList(laterPage).lines.find((entry) => entry.cellIndex === 0);
    expect(line).toBeDefined();
    const laterCellPosition = session.hitTest(laterPage, line!.x + 1, line!.y);
    expect(laterCellPosition.cellPath?.[0].cellIndex).toBe(0);
    expect(laterCellPosition.cursorRect.pageIndex).toBe(laterPage);
    session.insertText(laterCellPosition, "!");
    expect(session.paragraphs().find((paragraph) => paragraph.table)?.table?.cells[0].paragraphs[0].text.length).toBe(originalText.length + 1);
    session.undo();
    expect(session.paragraphs().find((paragraph) => paragraph.table)?.table?.cells[0].paragraphs[0].text.length).toBe(originalText.length);
    session.redo();
    expectLayoutMatchesFullReflow(session);
    session.dispose();
  });

  it("renders page-local display lists and retains unaffected page SVG caches", () => {
    const session = createInMemoryTextSession(Array.from({ length: LINES_PER_PAGE * 3 }, (_, index) => ({ text: `page line ${index}` })));
    const lastPageSvg = session.renderPage(2);
    const lastPageRevision = session.renderRevision(2);
    const firstLine = session.displayList(0).lines[0];
    const caret = session.hitTest(0, firstLine.x, firstLine.y);
    session.insertText(caret, "문자");
    expect(session.renderPage(2)).toBe(lastPageSvg);
    expect(session.renderRevision(2)).toBe(lastPageRevision);
    expect(session.displayList(0).lines[0].text).toContain("문자");
    session.dispose();
  });
});

function readRssBytes(): number | null {
  const runtime = globalThis as typeof globalThis & { process?: { memoryUsage?: () => { rss: number } } };
  return runtime.process?.memoryUsage?.().rss ?? null;
}

function expectLayoutMatchesFullReflow(session: ReturnType<typeof createInMemoryTextSession>) {
  const reference = createInMemoryTextSession(session.paragraphs(), session.pageDefinition(0));
  try {
    expect(session.pageCount).toBe(reference.pageCount);
    for (let pageIndex = 0; pageIndex < session.pageCount; pageIndex += 1) {
      const withoutParagraphIds = (page: ReturnType<typeof session.displayList>) => ({
        ...page,
        lines: page.lines.map(({ paragraphId: _paragraphId, ...line }) => line),
        tables: page.tables.map(({ paragraphId: _paragraphId, ...table }) => table),
      });
      expect(withoutParagraphIds(session.displayList(pageIndex))).toEqual(withoutParagraphIds(reference.displayList(pageIndex)));
      expect(session.renderPage(pageIndex)).toBe(reference.renderPage(pageIndex));
    }
  } finally {
    reference.dispose();
  }
}
