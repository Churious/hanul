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
  const rssAfterEdits = process.memoryUsage().rss;
  session.dispose();
  console.log(JSON.stringify({ pages, paragraphs: pages * 44, constructionMs, rssBeforeBytes: rssBefore, rssAfterCreateBytes: rssAfterCreate, modelRssDeltaBytes: rssAfterCreate - rssBefore, rssAfterEditsBytes: rssAfterEdits, edits }));
  process.exit(0);
}

const rows = [];
for (const pages of pageCounts) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--expose-gc", scriptPath, "--child", String(pages)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Benchmark failed for ${pages} pages:\n${result.stderr}\n${result.stdout}`);
  rows.push(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)));
}
console.log(JSON.stringify({ platform: process.platform, node: process.version, measurements: "Fresh Node process per size; model/layout/SVG synchronous timings only (no React commit or physical display latency)", rows }, null, 2));
