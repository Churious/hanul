// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createFileMenuItems, type FileMenuItem } from "./file-menu-model";

function itemById(items: ReturnType<typeof createFileMenuItems>, id: string): FileMenuItem | undefined {
  const entry = items.find((candidate) => candidate.id === id);
  return entry && "kind" in entry ? undefined : entry;
}

describe("file ribbon menu model", () => {
  it("keeps the requested menu order and exposes only working commands", () => {
    const items = createFileMenuItems([], { hasDocument: true, canExit: true });
    expect(items.map((entry) => entry.id)).toEqual([
      "new-document", "document-garden", "start-assistant", "before-open", "open-document",
      "convert-pdf", "convert-image", "xml-document", "before-save", "save-document", "save-as",
      "save-pdf", "save-mobile", "document-info", "before-accessibility", "daisy", "ccl",
      "public-nuri", "braille", "before-send", "send", "before-page", "page-setup", "preview",
      "print", "before-recent", "recent-documents", "before-close", "close-document", "exit",
    ]);
    expect(itemById(items, "new-document")?.shortcut).toBe("Ctrl+N");
    expect(itemById(items, "open-document")?.shortcut).toBe("Ctrl+O");
    expect(itemById(items, "save-document")?.shortcut).toBe("Ctrl+S");
    expect(itemById(items, "save-as")?.shortcut).toBe("Ctrl+Shift+S");
    expect(itemById(items, "print")?.disabled).toBe(true);
    expect(itemById(items, "save-document")?.disabled).toBe(false);
  });

  it("adds recent paths as open commands and disables document actions without a document", () => {
    const items = createFileMenuItems([{ path: "C:/docs/보고서.hwpx", label: "보고서.hwpx" }], { hasDocument: false, canExit: false });
    const recent = itemById(items, "recent-documents");
    expect(recent?.children?.[0]).toMatchObject({
      label: "보고서.hwpx",
      command: "open-recent",
      argument: "C:/docs/보고서.hwpx",
    });
    expect(itemById(items, "save-document")?.disabled).toBe(true);
    expect(itemById(items, "close-document")?.disabled).toBe(true);
    expect(itemById(items, "exit")?.disabled).toBe(true);
  });
});
