/**
 * Keeps only the latest asynchronous document open request eligible to
 * replace the active session. Opening a second file or closing the document
 * invalidates older parse results without touching the current session.
 */
export class LatestDocumentLoad {
  private revision = 0;

  begin(): number {
    this.revision += 1;
    return this.revision;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }

  invalidate(): void {
    this.revision += 1;
  }
}

/** Prevent overlapping save transactions from racing a document transition. */
export class DocumentSaveLock {
  private locked = false;

  acquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  release(): void {
    this.locked = false;
  }

  get isLocked(): boolean {
    return this.locked;
  }
}

/** A pending close/open/exit may continue only if no edits followed the saved snapshot. */
export function canContinueAfterSave(savedRevision: number, currentRevision: number): boolean {
  return savedRevision === currentRevision;
}

/** Commit a parsed session only if it still corresponds to the latest request. */
export function commitLatestDocumentLoad<T extends { dispose(): void }>(
  loads: LatestDocumentLoad,
  revision: number,
  candidate: T,
  replaceActive: (candidate: T) => void,
): boolean {
  if (!loads.isCurrent(revision)) {
    candidate.dispose();
    return false;
  }
  replaceActive(candidate);
  return true;
}

export type PendingDocumentAction =
  | { kind: "open"; pending: { name: string; size: number; file?: File; path?: string; createNew?: true } }
  | { kind: "close" }
  | { kind: "exit" };

export type UnsavedChoice = "save" | "discard" | "cancel";

export type UnsavedChoiceResult =
  | { kind: "cancel" }
  | { kind: "save-before-continue"; action: PendingDocumentAction }
  | { kind: "continue-without-saving"; action: PendingDocumentAction };

/** Make the destructive choice explicit and keep the requested action attached to Save. */
export function resolveUnsavedChoice(
  action: PendingDocumentAction | null,
  choice: UnsavedChoice,
): UnsavedChoiceResult {
  if (choice === "cancel" || !action) return { kind: "cancel" };
  return choice === "save"
    ? { kind: "save-before-continue", action }
    : { kind: "continue-without-saving", action };
}
