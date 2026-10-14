import init, { HwpDocument } from "@rhwp/core";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const MiB = 1024 * 1024;
const cacheLimit = Number(process.argv.find((argument) => argument.startsWith("--cache-limit="))?.split("=")[1] ?? 12);
const inputArgument = process.argv.find((argument) => argument.startsWith("--input="))?.slice("--input=".length);
const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "hanul-open-bench-"));

function memorySnapshot() {
  globalThis.gc?.();
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return {
    rssMiB: Number((rss / MiB).toFixed(1)),
    heapMiB: Number((heapUsed / MiB).toFixed(1)),
    externalMiB: Number((external / MiB).toFixed(1)),
    arrayBuffersMiB: Number((arrayBuffers / MiB).toFixed(1)),
  };
}

function elapsed(start) {
  return Number((performance.now() - start).toFixed(1));
}

async function measureInit() {
  const wasm = new Uint8Array(await readFile(new URL("../node_modules/@rhwp/core/rhwp_bg.wasm", import.meta.url)));
  const start = performance.now();
  await init({ module_or_path: wasm });
  return elapsed(start);
}

function createFixture(lineCount) {
  const document = HwpDocument.createEmpty();
  document.createBlankDocument();
  if (lineCount > 0) {
    const content = ("Hanul 성능 측정용 본문 문장입니다. 0123456789 가나다라마바사아자차카타파하\n").repeat(lineCount);
    document.insertText(0, 0, 0, content);
  }
  return document;
}

async function writeFixtures() {
  const fixtures = [];
  for (const [size, lineCount] of [["small", 60], ["large", 4000]]) {
    const source = createFixture(lineCount);
    try {
      for (const format of ["hwp", "hwpx"]) {
        const bytes = format === "hwp" ? source.exportHwp() : source.exportHwpx();
        const filePath = path.join(outputDirectory, `${size}.${format}`);
        await writeFile(filePath, bytes);
        fixtures.push({ size, format, filePath, bytes: bytes.byteLength, generatedPages: source.pageCount() });
      }
    } finally {
      source.free();
    }
  }
  return fixtures;
}

async function inputFixture(inputPath) {
  const filePath = path.resolve(inputPath);
  const format = path.extname(filePath).slice(1).toLowerCase();
  if (format !== "hwp" && format !== "hwpx") {
    throw new Error(`--input must point to an .hwp or .hwpx file: ${filePath}`);
  }
  const fileInfo = await stat(filePath);
  return [{ size: "provided", format, filePath, bytes: fileInfo.size }];
}

async function measureOpen(fixture) {
  const before = memorySnapshot();
  let start = performance.now();
  const fileBuffer = await readFile(fixture.filePath);
  const readMs = elapsed(start);
  // This view wraps Node's buffer without allocating a second copy.
  const bytes = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);
  const afterRead = memorySnapshot();

  start = performance.now();
  const document = new HwpDocument(bytes);
  const parseAndLayoutMs = elapsed(start);
  const afterParse = memorySnapshot();
  try {
    start = performance.now();
    const pageCount = document.pageCount();
    const pageCountMs = elapsed(start);

    start = performance.now();
    document.getPageInfo(0);
    const firstPageInfoMs = elapsed(start);

    const candidatePages = [...new Set([0, Math.floor(pageCount / 2), Math.max(0, pageCount - 1)])];
    start = performance.now();
    let svgBytes = 0;
    for (const pageIndex of candidatePages) {
      svgBytes += new TextEncoder().encode(document.renderPageSvg(pageIndex)).byteLength;
    }
    const representativePageRenderMs = elapsed(start);
    const afterRender = memorySnapshot();

    start = performance.now();
    const renderedPages = new Map();
    let retainedSvgBytes = 0;
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const svg = document.renderPageSvg(pageIndex);
      renderedPages.set(pageIndex, svg);
      retainedSvgBytes += new TextEncoder().encode(svg).byteLength;
      if (cacheLimit > 0 && renderedPages.size > cacheLimit) {
        const oldestPage = renderedPages.keys().next().value;
        renderedPages.delete(oldestPage);
      }
    }
    const allPageRenderMs = elapsed(start);
    const afterAllPages = memorySnapshot();

    return {
      size: fixture.size,
      format: fixture.format,
      fileBytes: fileBuffer.byteLength,
      pages: pageCount,
      stagesMs: {
        fileRead: readMs,
        rhwpParseModelAndInitialLayout: parseAndLayoutMs,
        pageCountLookup: pageCountMs,
        firstPageMetadata: firstPageInfoMs,
        firstMiddleLastPageRender: representativePageRenderMs,
        allPagesRender: allPageRenderMs,
      },
      renderedRepresentativeSvgBytes: svgBytes,
      retainedRenderedPageCache: {
        limit: cacheLimit || "unbounded",
        pageEntries: renderedPages.size,
        svgBytes: Array.from(renderedPages.values()).reduce((total, svg) => total + new TextEncoder().encode(svg).byteLength, 0),
        allPagesSvgBytesGenerated: retainedSvgBytes,
      },
      memoryMiB: { before, afterRead, afterParse, afterRender, afterAllPages },
      note: "RHWP DocumentCore::from_bytes parses, recomposes, and paginates within HwpDocument construction; its public WASM API does not expose separate timers for those internals.",
    };
  } finally {
    document.free();
  }
}

try {
  // Same fallback measurement callback used by the repository's Node RHWP tests.
  globalThis.measureTextWidth = (_font, text) => text.length * 8;
  const wasmInitMs = await measureInit();
  const fixtures = inputArgument ? await inputFixture(inputArgument) : await writeFixtures();
  const results = [];
  for (const fixture of fixtures) results.push(await measureOpen(fixture));
  console.log(JSON.stringify({
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    wasmInitMs: Number(wasmInitMs.toFixed(1)),
    renderCacheLimit: cacheLimit || "unbounded",
    fixtures: fixtures.map(({ size, format, bytes, generatedPages }) => ({ size, format, bytes, generatedPages })),
    results,
    limitations: [
      "No GUI or WebView is started; React DOM commit time is measured by in-app development diagnostics, not this Node benchmark.",
      "Layout uses the Node test text-width callback, so absolute timing and line wrapping differ from the Windows/Linux WebView font environment.",
      "Without --input the benchmark creates synthetic HWP/HWPX fixtures; --input reads an existing .hwp/.hwpx without modifying it or printing its path.",
    ],
  }, null, 2));
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
