import { describe, expect, it, vi } from "vitest";
import { canContinueAfterSave, commitLatestDocumentLoad, DocumentSaveLock, LatestDocumentLoad, resolveUnsavedChoice, type PendingDocumentAction } from "./document-lifecycle";

describe("document lifecycle", () => {
  it("allows only one save transaction until it releases the document transition lock", () => {
    const lock = new DocumentSaveLock();

    expect(lock.isLocked).toBe(false);
    expect(lock.acquire()).toBe(true);
    expect(lock.isLocked).toBe(true);
    expect(lock.acquire()).toBe(false);

    lock.release();

    expect(lock.isLocked).toBe(false);
    expect(lock.acquire()).toBe(true);
  });

  it("keeps the current document when edits happen after the exported snapshot", () => {
    expect(canContinueAfterSave(7, 7)).toBe(true);
    expect(canContinueAfterSave(7, 8)).toBe(false);
  });

  it("does not let an older asynchronous open replace the latest request", () => {
    const loads = new LatestDocumentLoad();
    const first = loads.begin();
    const second = loads.begin();

    expect(loads.isCurrent(first)).toBe(false);
    expect(loads.isCurrent(second)).toBe(true);
  });

  it("invalidates pending loads when the current document is closed or the app unmounts", () => {
    const loads = new LatestDocumentLoad();
    const request = loads.begin();

    loads.invalidate();

    expect(loads.isCurrent(request)).toBe(false);
  });

  it("disposes stale parsed sessions without replacing the active one", () => {
    const loads = new LatestDocumentLoad();
    const staleRequest = loads.begin();
    loads.begin();
    const candidate = { dispose: vi.fn() };
    const replaceActive = vi.fn();

    expect(commitLatestDocumentLoad(loads, staleRequest, candidate, replaceActive)).toBe(false);
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(replaceActive).not.toHaveBeenCalled();
  });

  it("replaces the active session for the current request without disposing it", () => {
    const loads = new LatestDocumentLoad();
    const request = loads.begin();
    const candidate = { dispose: vi.fn() };
    const replaceActive = vi.fn();

    expect(commitLatestDocumentLoad(loads, request, candidate, replaceActive)).toBe(true);
    expect(candidate.dispose).not.toHaveBeenCalled();
    expect(replaceActive).toHaveBeenCalledWith(candidate);
  });

  it.each<PendingDocumentAction>([
    { kind: "open", pending: { name: "report.hwpx", path: "C:/docs/report.hwpx", size: 128 } },
    { kind: "close" },
    { kind: "exit" },
  ])("preserves the requested %s action across Save", (action) => {
    expect(resolveUnsavedChoice(action, "save")).toEqual({
      kind: "save-before-continue",
      action,
    });
  });

  it("continues only after an explicit discard and leaves cancel without an action", () => {
    const action: PendingDocumentAction = { kind: "close" };
    expect(resolveUnsavedChoice(action, "discard")).toEqual({
      kind: "continue-without-saving",
      action,
    });
    expect(resolveUnsavedChoice(action, "cancel")).toEqual({ kind: "cancel" });
    expect(resolveUnsavedChoice(null, "discard")).toEqual({ kind: "cancel" });
  });
});
