import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const htmlPath = join(import.meta.dirname, "rendering-poc.html");

function resolveBrowser() {
  const override = process.env.HANUL_RENDER_BROWSER;
  if (override) return override;
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      ]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/microsoft-edge"];
  const browser = candidates.find((candidate) => existsSync(candidate));
  if (browser) return browser;
  throw new Error("Chromium 기반 브라우저를 찾지 못했습니다. HANUL_RENDER_BROWSER 환경 변수에 실행 파일 경로를 지정하세요.");
}

function runMode(browser, mode, repetition) {
  const profileDir = mkdtempSync(join(tmpdir(), `hanul-render-${process.pid}-${mode}-${repetition}-`));
  try {
    const url = new URL(pathToFileURL(htmlPath).href);
    url.searchParams.set("mode", mode);
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--js-flags=--expose-gc",
      `--user-data-dir=${profileDir}`,
      "--virtual-time-budget=60000",
      "--dump-dom",
      url.href,
    ];
    const completed = spawnSync(browser, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    if (completed.error) throw completed.error;
    if (completed.status !== 0) {
      throw new Error(`${mode} benchmark failed (exit ${completed.status}): ${completed.stderr.slice(-3000)}`);
    }
    const dom = completed.stdout;
    const match = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/);
    if (!match || match[1] === "pending") {
      throw new Error(`${mode} benchmark did not publish metrics. Browser output: ${dom.slice(-3000)}`);
    }
    return JSON.parse(match[1]);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
}

const browser = resolveBrowser();
const repetitions = 3;
const runs = [];
for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  runs.push(runMode(browser, "svg", repetition));
  runs.push(runMode(browser, "canvas", repetition));
}
const results = ["svg", "canvas"].map((mode) => {
  const modeRuns = runs.filter((run) => run.mode === mode);
  const metricNames = [
    "firstPageMs",
    "viewportSixPagesMs",
    "averageRepeatedWindowMs",
    "fullDocumentWindowedMs",
  ];
  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return {
    mode,
    medianMetrics: Object.fromEntries(metricNames.map((name) => [name, median(modeRuns.map((run) => run[name]))])),
    runs: modeRuns,
  };
});
console.log(JSON.stringify({
  benchmark: "Hanul shared display-list SVG vs Canvas 2D PoC",
  browserExecutable: browser,
  platform: process.platform,
  node: process.version,
  repetitions: `${repetitions} isolated cold browser runs per backend; SVG and Canvas runs are interleaved. Median summarizes timings.`,
  results,
}, null, 2));
