// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createFileMenuItems, type FileMenuItem } from "./file-menu-model";

function itemById(items: ReturnType<typeof createFileMenuItems>, id: string): FileMenuItem | undefined {
  const entry = items.find((candidate) => candidate.id === id);
  return entry && "kind" in entry ? undefined : entry;
}

describe("file ribbon menu model", () => {
  it("keeps the compact word-processor menu order and omits low-use services", () => {
    const items = createFileMenuItems([], { hasDocument: true, canEditPage: true, canExit: true, canExportPdf: true });
    expect(items.map((entry) => entry.id)).toEqual([
      "new-document", "before-open", "open-document", "before-save", "save-document", "save-as",
      "export-pdf", "before-info", "document-info", "before-page", "page-setup", "preview",
      "print", "before-recent", "recent-documents", "before-close", "close-document", "exit",
    ]);
    const visibleLabels = items.flatMap((entry) => "kind" in entry ? [] : [entry.label]);
    expect(visibleLabels).not.toContain("문서마당");
    expect(visibleLabels).not.toContain("DAISY 문서");
    expect(itemById(items, "new-document")?.shortcut).toBe("Ctrl+N");
    expect(itemById(items, "open-document")?.shortcut).toBe("Ctrl+O");
    expect(itemById(items, "save-document")?.shortcut).toBe("Ctrl+S");
    expect(itemById(items, "save-as")?.shortcut).toBe("Ctrl+Shift+S");
    expect(itemById(items, "print")?.shortcut).toBe("Ctrl+P");
    expect(itemById(items, "print")?.disabled).toBe(false);
    expect(itemById(items, "export-pdf")?.command).toBe("export-pdf");
    expect(itemById(items, "save-document")?.disabled).toBe(false);
  });

  it("adds recent paths as open commands and disables document actions without a document", () => {
    const items = createFileMenuItems([{ path: "C:/docs/보고서.hwpx", label: "보고서.hwpx" }], { hasDocument: false, canEditPage: false, canExit: false, canExportPdf: true });
    const recent = itemById(items, "recent-documents");
    expect(recent?.children?.[0]).toMatchObject({
      label: "보고서.hwpx",
      command: "open-recent",
      argument: "C:/docs/보고서.hwpx",
    });
    expect(itemById(items, "save-document")?.disabled).toBe(true);
    expect(itemById(items, "export-pdf")?.disabled).toBe(true);
    expect(itemById(items, "page-setup")?.disabled).toBe(true);
    expect(itemById(items, "print")?.disabled).toBe(true);
    expect(itemById(items, "close-document")?.disabled).toBe(true);
    expect(itemById(items, "exit")?.disabled).toBe(true);
  });

  it("requires an active page insertion position before opening page setup", () => {
    const items = createFileMenuItems([], { hasDocument: true, canEditPage: false, canExit: true, canExportPdf: true });
    expect(itemById(items, "page-setup")?.disabled).toBe(true);
    expect(itemById(items, "page-setup")?.disabledReason).toContain("편집 위치");
  });

  it("does not advertise PDF export as available outside the desktop app", () => {
    const items = createFileMenuItems([], { hasDocument: true, canEditPage: true, canExit: false, canExportPdf: false });
    expect(itemById(items, "export-pdf")?.disabled).toBe(true);
    expect(itemById(items, "export-pdf")?.disabledReason).toContain("데스크톱 앱");
  });
});
