import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(desktopDir, "..", "..");
const windows = process.platform === "win32";
if (!windows) {
  console.error("Native-dialog GUI E2E is currently supported on Windows only. WSLg launched and rendered the app, but its Linux file-picker flow could not be driven reliably; see docs/testing/desktop-file-lifecycle-e2e.md.");
  process.exit(2);
}
const port = Number(process.env.HANUL_E2E_WEBDRIVER_PORT || 4445);
const webdriverUrl = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(path.join(tmpdir(), "hanul-v102c-e2e-"));
const targetDir = process.env.HANUL_E2E_CARGO_TARGET || path.join(tmpdir(), "hanul-v102c-cargo-target");
await mkdir(targetDir, { recursive: true });

const env = {
  ...process.env,
  CARGO_TARGET_DIR: targetDir,
  HANUL_E2E_PORT: "1422",
  TAURI_WEBDRIVER_PORT: String(port),
};
const tauriCli = path.join(desktopDir, "node_modules", "@tauri-apps", "cli", "tauri.js");
const appProcess = spawn(process.execPath, [tauriCli, "dev", "--config", "src-tauri/tauri.e2e.conf.json", "--features", "webdriver-e2e", "--no-watch"], {
  cwd: desktopDir,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: false,
});

let appOutput = "";
const appendOutput = (chunk) => {
  appOutput = `${appOutput}${chunk.toString()}`.slice(-16000);
  process.stdout.write(chunk);
};
appProcess.stdout.on("data", appendOutput);
appProcess.stderr.on("data", appendOutput);

let sessionId;
let assertions = 0;
const failures = [];

async function request(method, route, body) {
  const response = await fetch(`${webdriverUrl}${route}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.value?.error) {
    throw new Error(`${method} ${route} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload.value;
}

async function waitFor(check, message, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`${message}${lastError ? ` (${lastError.message})` : ""}`);
}

async function element(selector, using = "css selector") {
  const value = await request("POST", `/session/${sessionId}/element`, { using, value: selector });
  const id = value?.["element-6066-11e4-a52e-4f735466cecf"] ?? value?.ELEMENT;
  if (!id) throw new Error(`WebDriver returned no element for ${selector}`);
  return id;
}

async function hasElement(selector, using = "css selector") {
  const result = await request("POST", `/session/${sessionId}/elements`, { using, value: selector });
  return Array.isArray(result) && result.length > 0;
}

async function click(selector, using) {
  const id = await element(selector, using);
  await request("POST", `/session/${sessionId}/element/${id}/click`, {});
}

async function sendKeys(selector, text, using = "css selector") {
  const id = await element(selector, using);
  const chars = Array.from(text);
  await request("POST", `/session/${sessionId}/element/${id}/value`, { text, value: chars });
}

async function script(script, args = []) {
  return request("POST", `/session/${sessionId}/execute/sync`, { script, args });
}

async function clickFileCommand(label) {
  await click(".file-menu-trigger");
  const xpath = `//button[@role='menuitem' and contains(normalize-space(.), '${label}')]`;
  await waitFor(() => hasElement(xpath, "xpath"), `File menu item did not appear: ${label}`);
  await click(xpath, "xpath");
}

async function typeMarker(marker) {
  await waitFor(async () => await script("return Boolean(document.querySelector('.ime-input'))"), "Editor input was not ready");
  // Tauri's Linux WebDriver implementation calls HTMLElement.click() directly;
  // SVGTextElement in WebKitGTK does not expose that method. The editor's hidden
  // IME input is the actual text entry surface, so focus it directly on Linux.
  const target = await hasElement(".page-svg text") ? ".page-svg text" : ".page-svg";
  if (await hasElement(target)) {
    await click(target);
    await delay(80);
  }
  await script("const input = document.querySelector('.ime-input'); input.focus(); input.value = ''; return document.activeElement === input");
  await sendKeys(".ime-input", marker);
  await waitFor(async () => (await script("return document.querySelector('.document-page')?.textContent ?? ''")).includes(marker), `Document model/render did not show input: ${marker}`);
}

async function pageText() {
  return script("return document.querySelector('.document-page')?.textContent ?? ''");
}

async function waitForDocumentPage(message) {
  try {
    await waitFor(async () => await script("return Boolean(document.querySelector('.document-page'))"), message, 30000);
  } catch (error) {
    const state = await script("return {body: document.body?.innerText ?? '', alerts: [...document.querySelectorAll('[role=alert]')].map(x => x.innerText), loading: document.querySelector('[role=status]')?.innerText ?? ''}");
    throw new Error(`${error.message}; state=${JSON.stringify(state)}`);
  }
}

async function unsavedDialogVisible() {
  return script("return [...document.querySelectorAll('.confirm-dialog[role=dialog]')].some(dialog => dialog.getClientRects().length > 0 && dialog.innerText.includes('저장하지 않은 변경 사항'))");
}

async function clickUnsavedChoice(label) {
  await click(`//section[@role='dialog' and @aria-labelledby='confirm-title']//button[normalize-space(.)='${label}']`, "xpath");
}

async function nativeDialog(mode, filePath, options = {}) {
  if (!windows) throw new Error("Native dialog automation is currently available on Windows only");
  const ps1 = path.join(scriptDir, "windows", "file-dialog.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Mode", mode, "-OwnerTitle", "Hanul V1-02c E2E", "-TimeoutSeconds", "15"];
  if (filePath) args.push("-Path", filePath);
  if (options.closeAppBeforeSelection) args.push("-CloseAppBeforeSelection");
  const helper = spawn("powershell.exe", args, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  helper.stdout.on("data", (chunk) => { output += chunk.toString(); });
  helper.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    helper.once("error", reject);
    helper.once("close", resolve);
  });
  if (exitCode !== 0) {
    const appState = await script("return {title: document.title, alert: document.querySelector('[role=alert]')?.innerText ?? '', body: document.body?.innerText?.slice(-500) ?? ''}").catch(() => null);
    throw new Error(`Windows UI Automation ${mode} failed: ${output.trim()}${appState ? `; app state=${JSON.stringify(appState)}` : ""}`);
  }
  return output.trim();
}

async function assertFileContains(filePath, marker) {
  const file = await readFile(filePath);
  assert.ok(file.byteLength > 100, `Expected a serialized document at ${filePath}`);
  const reopened = await pageText();
  assert.ok(reopened.includes(marker), `Reopened document did not render saved text '${marker}'`);
  assertions += 2;
}

async function runCase(name, callback) {
  process.stdout.write(`\n[GUI E2E] ${name} ... `);
  try {
    await callback();
    process.stdout.write("PASS\n");
  } catch (error) {
    const state = await script("return {alert: document.querySelector('[role=alert]')?.textContent ?? '', dialog: document.querySelector('[role=dialog]')?.innerText ?? '', dirty: document.querySelector('.dirty-status')?.textContent ?? '', body: document.body?.innerText?.slice(-500) ?? ''}").catch(() => null);
    if (state) error.message = `${error.message}; app=${JSON.stringify(state)}`;
    failures.push({ name, error });
    process.stdout.write(`FAIL\n${error.stack ?? error}\n`);
    throw error;
  }
}

async function clearDocument() {
  await clickFileCommand("문서 닫기");
  await waitFor(async () => !(await script("return Boolean(document.querySelector('.document-page'))")), "Document did not close");
}

async function openPath(filePath) {
  await clickFileCommand("불러오기");
  process.stdout.write(`${await nativeDialog("Open", filePath)}\n`);
  await waitForDocumentPage(`Document did not open: ${filePath}`);
}

async function saveAs(filePath) {
  await clickFileCommand("다른 이름으로 저장하기");
  process.stdout.write(`${await nativeDialog("Save", filePath)}\n`);
  try {
    await waitFor(async () => {
      try { await access(filePath); return (await stat(filePath)).size > 100; } catch { return false; }
    }, `Saved file did not appear: ${filePath}`, 30000);
  } catch (error) {
    const state = await script("return {alert: document.querySelector('[role=alert]')?.textContent ?? '', messages: [...document.querySelectorAll('.message-toast')].map(x => x.textContent), dirty: document.querySelector('.dirty-status')?.textContent ?? '', body: document.body?.innerText?.slice(-700) ?? ''}").catch(() => null);
    throw new Error(`${error.message}; app=${JSON.stringify(state)}`);
  }
  await waitFor(async () => (await script("return document.querySelector('.message-toast')?.textContent ?? ''")).includes("저장"), "Save success notification did not appear");
}

async function startWebDriver() {
  const deadline = Date.now() + 10 * 60 * 1000;
  let lastError;
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null) throw new Error(`Tauri app exited with ${appProcess.exitCode}:\n${appOutput}`);
    try {
      const status = await fetch(`${webdriverUrl}/status`, { signal: AbortSignal.timeout(1200) });
      if (status.ok) break;
    } catch (error) { lastError = error; }
    await delay(500);
  }
  if (Date.now() >= deadline) throw new Error(`Timed out waiting for embedded WebDriver: ${lastError?.message ?? "no status"}`);
  const created = await request("POST", "/session", {
    capabilities: {
      alwaysMatch: { browserName: "tauri", "wdio:tauriServiceOptions": { windowLabel: "main" } },
      firstMatch: [{}],
    },
  });
  sessionId = created.sessionId;
  await waitFor(async () => (await script("return document.readyState")) === "complete", "WebView navigation did not finish", 30000);
  await delay(500);
  const pageTitle = await script("return document.title");
  const pageLocation = await script("return location.href");
  const pageShell = await script("return Boolean(document.querySelector('.app-shell'))");
  const pageReadyState = await script("return document.readyState");
  const globals = await script("return {tauri: Boolean(window.__TAURI_INTERNALS__), react: typeof window.React, root: document.querySelector('#root')?.innerHTML?.length ?? -1}");
  const pageErrors = await script("return window.__hanulE2eErrors ?? []");
  process.stdout.write(`[WebDriver] title=${JSON.stringify(pageTitle)} url=${JSON.stringify(pageLocation)} ready=${JSON.stringify(pageReadyState)} appShell=${JSON.stringify(pageShell)} globals=${JSON.stringify(globals)} errors=${JSON.stringify(pageErrors)}\n`);
  await waitFor(async () => await script("return Boolean(document.querySelector('.app-shell'))"), "Isolated E2E Tauri window did not load");
}

function e2ePath(...parts) { return path.join(dataDir, ...parts); }

try {
  await startWebDriver();

  const newHwpx = e2ePath("new-document-roundtrip.hwpx");
  const newMarker = "V102C_NEW_DOCUMENT_ROUNDTRIP";
  await runCase("new → type → HWPX save → close → reopen (native picker + document content)", async () => {
    await clickFileCommand("새 문서");
    await waitForDocumentPage("New document did not create a page");
    await typeMarker(newMarker);
    await saveAs(newHwpx);
    await clearDocument();
    await openPath(newHwpx);
    await assertFileContains(newHwpx, newMarker);
  });

  const fixture = path.join(desktopDir, "test-fixtures", "hanul-textbox-body-50x24-hanword-gui-verified.hwp");
  const sourceHwp = e2ePath("existing-source.hwp");
  const editedHwp = e2ePath("existing-hwp-save-as.hwp");
  const existingMarker = "V102C_EXISTING_HWP_EDITED";
  await runCase("existing HWP → edit → Save As HWP → reopen", async () => {
    await copyFile(fixture, sourceHwp);
    await openPath(sourceHwp);
    await typeMarker(existingMarker);
    await saveAs(editedHwp);
    assert.ok((await pageText()).includes(existingMarker), "Save As changed the live HWP document content");
    assertions += 1;
    await clearDocument();
    await openPath(editedHwp);
    await assertFileContains(editedHwp, existingMarker);
  });

  await runCase("recent documents reopen the same path and content", async () => {
    await clearDocument();
    await click(".file-menu-trigger");
    await click("//button[@role='menuitem' and @data-submenu-id='recent-documents']", "xpath");
    const name = path.basename(editedHwp);
    await waitFor(() => hasElement(`//button[@role='menuitem' and contains(normalize-space(.), '${name}')]`, "xpath"), "Recent HWP child did not appear");
    await click(`//button[@role='menuitem' and contains(normalize-space(.), '${name}')]`, "xpath");
    await waitFor(async () => (await pageText()).includes(existingMarker), "Recent document did not reopen the edited HWP");
    assertions += 1;
    const moved = e2ePath("moved-out-of-recent-list.hwp");
    await rename(editedHwp, moved);
    await click(".file-menu-trigger");
    await click("//button[@role='menuitem' and @data-submenu-id='recent-documents']", "xpath");
    await waitFor(() => hasElement(`//button[@role='menuitem' and contains(normalize-space(.), '${name}')]`, "xpath"), "Stale recent child did not appear");
    await click(`//button[@role='menuitem' and contains(normalize-space(.), '${name}')]`, "xpath");
    await waitFor(async () => (await script("return document.querySelector('[role=alert]')?.textContent ?? ''")).includes("최근 문서를 열 수 없습니다"), "Missing recent path did not report and remove the stale entry");
    const recent = JSON.parse(await script("return window.localStorage.getItem('hanul.recent-documents.v1') ?? '[]'"));
    assert.ok(!recent.some((entry) => entry.path === editedHwp), "Stale recent path was not removed from persisted recent entries");
    await click("//button[normalize-space(.)='닫기']", "xpath");
    await waitFor(async () => !(await script("return document.querySelector('[role=alert]')?.textContent ?? ''")).includes("최근 문서를 열 수 없습니다"), "Stale recent alert did not dismiss");
    assertions += 1;
  });

  const cancelMarker = "V102C_CANCEL_PRESERVES_DOCUMENT";
  await runCase("unsaved close cancellation keeps editor content and dirty status", async () => {
    await typeMarker(cancelMarker);
    assert.equal(await script("return document.querySelector('.dirty-status')?.textContent ?? ''"), "저장되지 않은 변경 사항");
    await clickFileCommand("문서 닫기");
    await waitFor(unsavedDialogVisible, "Unsaved prompt did not appear");
    await clickUnsavedChoice("취소");
    await waitFor(async () => !(await unsavedDialogVisible()), "Cancel did not dismiss the prompt");
    assert.ok((await pageText()).includes(cancelMarker));
    const dirty = await script("return document.querySelector('.dirty-status')?.textContent ?? ''");
    assert.equal(dirty, "저장되지 않은 변경 사항");
    assertions += 2;
  });

  const savedOnClose = e2ePath("save-choice-on-close.hwpx");
  const saveChoiceMarker = "V102C_SAVE_CHOICE_ON_CLOSE";
  await runCase("unsaved close Save choice commits before closing", async () => {
    await clickFileCommand("새 문서");
    await waitFor(unsavedDialogVisible, "Unsaved prompt did not appear before starting the Save-choice case");
    await clickUnsavedChoice("저장 안 함");
    await waitForDocumentPage("Blank document did not replace the cancelled close document");
    await typeMarker(saveChoiceMarker);
    assert.equal(await script("return document.querySelector('.dirty-status')?.textContent ?? ''"), "저장되지 않은 변경 사항");
    await clickFileCommand("문서 닫기");
    await waitFor(unsavedDialogVisible, "Unsaved prompt did not appear before choosing Save");
    await clickUnsavedChoice("저장");
    await nativeDialog("Save", savedOnClose);
    await waitFor(async () => !(await script("return Boolean(document.querySelector('.document-page'))")), "Save choice did not continue the close action", 45000);
    const bytes = await readFile(savedOnClose);
    assert.ok(bytes.byteLength > 100);
    await openPath(savedOnClose);
    assert.ok((await pageText()).includes(saveChoiceMarker));
    assertions += 2;
  });

  const discardMarker = "V102C_DISCARD_CHOICE";
  await runCase("unsaved new-document Discard choice replaces content", async () => {
    await typeMarker(discardMarker);
    await clickFileCommand("새 문서");
    await waitFor(unsavedDialogVisible, "Unsaved prompt did not appear before discarding the document");
    await clickUnsavedChoice("저장 안 함");
    await waitFor(async () => !(await pageText()).includes(discardMarker)
      && !(await script("return document.querySelector('.dirty-status')?.textContent ?? ''")), "Discard did not replace the document content and dirty state");
    assert.ok(!(await pageText()).includes(discardMarker), "Discarded text remained in the new document");
    assertions += 1;
  });

  await runCase("save cancellation keeps unsaved prompt and document intact", async () => {
    await typeMarker("V102C_SAVE_DIALOG_CANCEL");
    await clickFileCommand("문서 닫기");
    await waitFor(unsavedDialogVisible, "Unsaved prompt did not appear before Save cancellation");
    await clickUnsavedChoice("저장");
    await nativeDialog("Cancel");
    await waitFor(unsavedDialogVisible, "Save cancel did not preserve the unsaved confirmation");
    assert.ok((await pageText()).includes("V102C_SAVE_DIALOG_CANCEL"));
    await waitFor(async () => await script("return [...document.querySelectorAll('.confirm-dialog[role=dialog] button')].some(button => button.innerText.trim() === '취소' && !button.disabled)"), "Unsaved prompt Cancel remained disabled after file-picker cancellation");
    await clickUnsavedChoice("취소");
    await waitFor(async () => !(await unsavedDialogVisible()), "Cancel after file-picker cancellation did not dismiss the unsaved prompt");
    assertions += 1;
  });

  await runCase("invalid save path reports failure without clearing dirty state", async () => {
    await typeMarker("V102C_SAVE_FAILURE");
    await clickFileCommand("다른 이름으로 저장하기");
    const deniedPath = path.join(tmpdir(), `hanul-v102c-outside-scope-${process.pid}.hwpx`);
    await nativeDialog("Save", deniedPath);
    await waitFor(async () => (await script("return document.querySelector('[role=alert]')?.textContent ?? ''")).includes("저장하지 못했습니다"), "Save failure message did not appear", 30000);
    assert.equal(await stat(deniedPath).then(() => true, () => false), false);
    assert.equal(await script("return document.querySelector('.dirty-status')?.textContent ?? ''"), "저장되지 않은 변경 사항");
    assertions += 2;
  });

  await runCase("native window close request opens dirty confirmation and Cancel preserves document", async () => {
    await nativeDialog("Close");
    await waitFor(unsavedDialogVisible, "Native close request did not open the unsaved prompt");
    const text = await pageText();
    assert.ok(text.includes("V102C_SAVE_FAILURE"));
    await clickUnsavedChoice("취소");
    assert.ok((await pageText()).includes("V102C_SAVE_FAILURE"));
    assertions += 2;
  });

  const saveDuringClosePath = e2ePath("save-lock-close-guard.hwpx");
  await runCase("window close request while native save picker is open cannot discard active document", async () => {
    await clickFileCommand("새 문서");
    await waitFor(unsavedDialogVisible, "Unsaved prompt did not appear before resetting for save-lock case");
    await clickUnsavedChoice("저장 안 함");
    await typeMarker("V102C_SAVE_LOCK_CLOSE_GUARD");
    await clickFileCommand("문서 닫기");
    await waitFor(unsavedDialogVisible, "Unsaved prompt did not appear before save-lock case");
    await clickUnsavedChoice("저장");
    await nativeDialog("Save", saveDuringClosePath, { closeAppBeforeSelection: true });
    await waitFor(async () => (await script("return document.querySelector('.message-toast')?.textContent ?? ''")).includes("저장했습니다"), "Save did not finish after the close guard", 30000);
    await waitFor(async () => !(await script("return Boolean(document.querySelector('.document-page'))")), "Requested document close did not run after save", 30000);
    assert.ok((await readFile(saveDuringClosePath)).byteLength > 100);
    await openPath(saveDuringClosePath);
    assert.ok((await pageText()).includes("V102C_SAVE_LOCK_CLOSE_GUARD"));
    assertions += 2;
  });

  await runCase("application exit offers Cancel and Discard", async () => {
    await typeMarker("V102C_EXIT_CONFIRM");
    await clickFileCommand("끝");
    await waitFor(unsavedDialogVisible, "Exit did not show the unsaved prompt");
    await clickUnsavedChoice("취소");
    assert.ok((await pageText()).includes("V102C_EXIT_CONFIRM"));
    await clickFileCommand("끝");
    await clickUnsavedChoice("저장 안 함");
    if (windows) {
      await nativeDialog("WaitClosed");
    } else {
      await waitFor(async () => {
        try { await request("GET", `/session/${sessionId}/window/handles`); return false; } catch { return true; }
      }, "Exit after discard did not close the application", 10000);
    }
    assertions += 1;
  });

  if (sessionId) {
    // The app-exit scenario closes the WebDriver host together with its window,
    // so session teardown is best-effort after that expected process shutdown.
    await request("DELETE", `/session/${sessionId}`).catch(() => {});
    sessionId = undefined;
  }
  if (windows) {
  }
} catch (error) {
  if (!failures.length) failures.push({ name: "harness startup/teardown", error });
  process.stderr.write(`${error.stack ?? error}\n`);
} finally {
  if (sessionId) {
    await request("DELETE", `/session/${sessionId}`).catch(() => {});
  }
  if (appProcess.exitCode === null) {
    if (windows && appProcess.pid) {
      await new Promise((resolve) => {
        const killer = spawn("taskkill.exe", ["/PID", String(appProcess.pid), "/T", "/F"], { stdio: "ignore" });
        killer.once("close", resolve);
      });
    } else {
      appProcess.kill("SIGTERM");
    }
  }
}

process.stdout.write(`\nDesktop GUI assertions: ${assertions}; failed scenarios: ${failures.length}\n`);
if (failures.length) {
  process.stderr.write(`Test data retained for diagnosis: ${dataDir}\n`);
  for (const failure of failures) process.stderr.write(`- ${failure.name}: ${failure.error.message}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Test data: ${dataDir}\n`);
}
