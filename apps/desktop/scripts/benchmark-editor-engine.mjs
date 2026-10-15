import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const pageCounts = [1, 35, 98, 500];

if (process.argv[2] === "--child") {
  const pages = Number(process.argv[3]);
  const { createInMemoryTextSession } = await import("../src/text-document-engine.ts");
  if (globalThis.gc) globalThis.gc();
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const session = createInMemoryTextSession(Array.from({ length: pages * 44 }, (_, i) => ({ text: `한글 문서 편집 조판 성능과 문단별 증분 배치를 검증합니다. ${String(i).padStart(4, "0")}` })));
  const constructionMs = performance.now() - started;
  if (globalThis.gc) globalThis.gc();
  const rssAfterCreate = process.memoryUsage().rss;
  const edits = [];
  for (const [location, page] of [["beginning", 0], ["middle", Math.floor(pages / 2)], ["end", pages - 1]]) {
    const line = session.displayList(page).lines[0];
    const start = session.hitTest(page, line.x + 1, line.y);
    const position = location === "end" ? session.moveCaretToParagraphEdge(start, "end") : start;
    const editStarted = performance.now();
    const next = session.insertText(position, "가");
    const editEnded = performance.now();
    const svg = session.renderPage(page);
    const renderedAt = performance.now();
    const metrics = { ...session.metrics };
    edits.push({
      location,
      modelMutationMs: metrics.modelMutationMs,
      incrementalLayoutMs: metrics.incrementalLayoutMs,
      pageSvgRenderMs: metrics.renderedPageMs,
      editToSvgMs: renderedAt - editStarted,
      synchronousEngineBlockMs: renderedAt - editStarted,
      invalidatedParagraphs: metrics.invalidatedParagraphs,
      invalidatedPages: metrics.invalidatedPages,
      outputBytes: svg.length,
    });
    if (session.selectedText(session.moveCaret(next, -1), next) !== "가") throw new Error(`${location}: inserted text mismatch`);
    session.undo(); session.redo();
  }
  const tableAnchorLine = session.displayList(pages - 1).lines[0];
  const tableAnchor = session.hitTest(pages - 1, tableAnchorLine.x + 1, tableAnchorLine.y);
  const tableCreateStarted = performance.now();
  let tableCaret = session.createTable(tableAnchor, 2, 2);
  const tableCreateElapsed = performance.now() - tableCreateStarted;
  const tableCreateMetrics = { ...session.metrics };
  const cellEditStarted = performance.now();
  tableCaret = session.insertText(tableCaret, "가");
  const afterCellEdit = performance.now();
  const typedCellSvg = session.renderPage(tableCaret.cursorRect.pageIndex);
  const afterCellRender = performance.now();
  const tableTypingMetrics = { ...session.metrics };
  const rowEditStarted = performance.now();
  session.editTable(tableCaret, "insertRowBelow");
  const afterRowEdit = performance.now();
  session.renderPage(tableCaret.cursorRect.pageIndex);
  const afterRowRender = performance.now();
  const tableRowMetrics = { ...session.metrics };
  const objectLine = session.displayList(0).lines.find((line) => line.cellIndex === undefined && line.objectControlIndex === undefined);
  if (!objectLine) throw new Error("no body paragraph is available for the object probe");
  const objectAnchor = session.hitTest(0, objectLine.x + 1, objectLine.y);
  const objectInsertStarted = performance.now();
  session.insertShape(objectAnchor, "rectangle", 40, 24);
  const objectInsertedAt = performance.now();
  const objectInsertMetrics = { ...session.metrics };
  const objectInsertSvg = session.renderPage(0);
  const objectInsertRenderMetrics = { ...session.metrics };
  const objectInsertRenderedAt = performance.now();
  const shape = session.listObjects(0).find((item) => item.kind === "rectangle");
  if (!shape) throw new Error("shape insertion did not create a document object");
  const objectMoveStarted = performance.now();
  session.updateObject(shape, { offsetXmm: shape.offsetXmm + 2, offsetYmm: shape.offsetYmm + 1 });
  const objectMovedAt = performance.now();
  const objectMoveMetrics = { ...session.metrics };
  const objectSvg = session.renderPage(0);
  const objectMoveRenderMetrics = { ...session.metrics };
  const objectRenderedAt = performance.now();
  const rssAfterEdits = process.memoryUsage().rss;
  session.dispose();
  console.log(JSON.stringify({
    pages,
    paragraphs: pages * 44,
    constructionMs,
    rssBeforeBytes: rssBefore,
    rssAfterCreateBytes: rssAfterCreate,
    modelRssDeltaBytes: rssAfterCreate - rssBefore,
    rssAfterEditsBytes: rssAfterEdits,
    edits,
    table: {
      model: "Hanul independent in-memory engine; synthetic paragraphs, not an imported HWP corpus",
      createTable: { elapsedMs: tableCreateElapsed, ...tableCreateMetrics },
      typeIntoCell: {
        modelAndLayoutMs: afterCellEdit - cellEditStarted,
        modelMutationMs: tableTypingMetrics.modelMutationMs,
        incrementalLayoutMs: tableTypingMetrics.incrementalLayoutMs,
        svgMs: tableTypingMetrics.renderedPageMs,
        editToSvgMs: afterCellRender - cellEditStarted,
        invalidatedParagraphs: tableTypingMetrics.invalidatedParagraphs,
        invalidatedPages: tableTypingMetrics.invalidatedPages,
        svgBytes: typedCellSvg.length,
      },
      insertRow: {
        modelAndLayoutMs: afterRowEdit - rowEditStarted,
        incrementalLayoutMs: tableRowMetrics.incrementalLayoutMs,
        svgMs: tableRowMetrics.renderedPageMs,
        editToSvgMs: afterRowRender - rowEditStarted,
        invalidatedParagraphs: tableRowMetrics.invalidatedParagraphs,
        invalidatedPages: tableRowMetrics.invalidatedPages,
      },
      insertRectangle: {
        modelMutationMs: objectInsertMetrics.modelMutationMs,
        incrementalLayoutMs: objectInsertMetrics.incrementalLayoutMs,
        svgMs: objectInsertRenderMetrics.renderedPageMs,
        modelToSvgMs: objectInsertRenderedAt - objectInsertStarted,
        elapsedThroughLayoutMs: objectInsertedAt - objectInsertStarted,
        invalidatedParagraphs: objectInsertMetrics.invalidatedParagraphs,
        invalidatedPages: objectInsertMetrics.invalidatedPages,
        svgBytes: objectInsertSvg.length,
      },
      moveRectangle: {
        modelMutationMs: objectMoveMetrics.modelMutationMs,
        incrementalLayoutMs: objectMoveMetrics.incrementalLayoutMs,
        svgMs: objectMoveRenderMetrics.renderedPageMs,
        modelToSvgMs: objectRenderedAt - objectMoveStarted,
        elapsedThroughLayoutMs: objectMovedAt - objectMoveStarted,
        invalidatedParagraphs: objectMoveMetrics.invalidatedParagraphs,
        invalidatedPages: objectMoveMetrics.invalidatedPages,
        svgBytes: objectSvg.length,
      },
    },
  }));
  process.exit(0);
}

const rows = [];
for (const pages of pageCounts) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--expose-gc", scriptPath, "--child", String(pages)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Benchmark failed for ${pages} pages:\n${result.stderr}\n${result.stdout}`);
  rows.push(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)));
}
console.log(JSON.stringify({ platform: process.platform, node: process.version, measurements: "Fresh Node process per size; model/layout/SVG synchronous timings only (no React commit or physical display latency)", rows }, null, 2));
