import { describe, expect, it } from "vitest";
import { ImeInputGate } from "./ime-input";
import { createInMemoryTextSession } from "./text-document-engine";

const LINES_PER_PAGE = 44;
const syntheticParagraph = (index: number) => `한글 문서 편집 조판 성능과 문단별 증분 배치를 검증합니다. ${String(index).padStart(4, "0")}`;

describe("Hanul paragraph text engine", () => {
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
      });
      expect(withoutParagraphIds(session.displayList(pageIndex))).toEqual(withoutParagraphIds(reference.displayList(pageIndex)));
      expect(session.renderPage(pageIndex)).toBe(reference.renderPage(pageIndex));
    }
  } finally {
    reference.dispose();
  }
}
