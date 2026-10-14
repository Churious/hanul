// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { forgetRecentDocument, readRecentDocuments, rememberRecentDocument } from "./recent-documents";

describe("recent document paths", () => {
  it("persists paths only, puts the newest path first, and de-duplicates", () => {
    const storage = window.localStorage;
    storage.clear();
    rememberRecentDocument(storage, { path: "C:/docs/one.hwpx", label: "one.hwpx" });
    rememberRecentDocument(storage, { path: "C:/docs/two.hwp", label: "two.hwp" });
    const result = rememberRecentDocument(storage, { path: "C:/docs/one.hwpx", label: "one-renamed.hwpx" });

    expect(result).toEqual([
      { path: "C:/docs/one.hwpx", label: "one-renamed.hwpx" },
      { path: "C:/docs/two.hwp", label: "two.hwp" },
    ]);
    expect(readRecentDocuments(storage)).toEqual(result);
  });

  it("removes stale paths and ignores malformed storage", () => {
    const storage = window.localStorage;
    storage.clear();
    rememberRecentDocument(storage, { path: "missing.hwp", label: "missing.hwp" });
    expect(forgetRecentDocument(storage, "missing.hwp")).toEqual([]);
    storage.setItem("hanul.recent-documents.v1", "not-json");
    expect(readRecentDocuments(storage)).toEqual([]);
  });
});
