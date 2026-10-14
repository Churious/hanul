export interface RecentDocument {
  path: string;
  label: string;
}

const storageKey = "hanul.recent-documents.v1";
const recentLimit = 12;

export function readRecentDocuments(storage: Pick<Storage, "getItem"> = localStorage): RecentDocument[] {
  try {
    const saved = storage.getItem(storageKey);
    if (!saved) return [];
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RecentDocument => Boolean(
        item
          && typeof item === "object"
          && typeof (item as RecentDocument).path === "string"
          && (item as RecentDocument).path.length > 0
          && typeof (item as RecentDocument).label === "string"
          && (item as RecentDocument).label.length > 0,
      ))
      .slice(0, recentLimit);
  } catch {
    return [];
  }
}

export function rememberRecentDocument(
  storage: Pick<Storage, "getItem" | "setItem">,
  document: RecentDocument,
): RecentDocument[] {
  if (!document.path) return readRecentDocuments(storage);
  const updated = [document, ...readRecentDocuments(storage).filter((item) => item.path !== document.path)]
    .slice(0, recentLimit);
  try {
    storage.setItem(storageKey, JSON.stringify(updated));
  } catch {
    // Recent paths are a convenience; storage failure must not interrupt editing.
  }
  return updated;
}

export function forgetRecentDocument(storage: Pick<Storage, "getItem" | "setItem">, path: string): RecentDocument[] {
  const updated = readRecentDocuments(storage).filter((item) => item.path !== path);
  try {
    storage.setItem(storageKey, JSON.stringify(updated));
  } catch {
    // Keep the current session usable when local storage is unavailable.
  }
  return updated;
}
