import { describe, expect, it } from "vitest";
import DOMPurify from "dompurify";
import {
  clampZoom,
  formatFileSize,
  sanitizeRenderedSvg,
  validateDocumentFile,
} from "./document-utils";

describe("document input helpers", () => {
  it("accepts HWP and HWPX files case-insensitively", () => {
    expect(validateDocumentFile("Report.HWP", 128)).toEqual({ ok: true });
    expect(validateDocumentFile("보고서.hwpx", 128)).toEqual({ ok: true });
  });

  it("rejects unsupported, empty, and oversized files", () => {
    expect(validateDocumentFile("notes.docx", 128).ok).toBe(false);
    expect(validateDocumentFile("empty.hwp", 0).ok).toBe(false);
    expect(validateDocumentFile("large.hwpx", 201 * 1024 * 1024).ok).toBe(false);
  });

  it("keeps zoom in the supported range", () => {
    expect(clampZoom(0.2)).toBe(0.5);
    expect(clampZoom(1.26)).toBe(1.3);
    expect(clampZoom(3)).toBe(2);
  });

  it("formats file sizes for the status bar", () => {
    expect(formatFileSize(750)).toBe("750 B");
    expect(formatFileSize(1024)).toBe("1 KB");
  });

  it("sanitizes unsafe SVG nodes and external references", () => {
    const rendered =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>' +
      '<path id="safe" fill="url(#safe)" d="M0 0"/>' +
      '<image href="https://example.invalid/image.png"/></svg>';
    const safe = sanitizeRenderedSvg(DOMPurify, rendered);
    expect(safe).toContain('id="safe"');
    expect(safe).not.toContain("<script");
    expect(safe).not.toContain("example.invalid");
  });
});
