export interface ImeInputEventState {
  inputType?: string;
  isComposing?: boolean;
}

interface PendingCompositionInput {
  text: string;
  expiresAt: number;
}

/** Keeps native IME preedit out of the document model until the OS commits it. */
export class ImeInputGate {
  private compositionActive = false;
  private compositionCanceled = false;
  private compositionText = "";
  private pendingCompositionInput: PendingCompositionInput | null = null;

  get isComposing() {
    return this.compositionActive;
  }

  startComposition() {
    this.compositionActive = true;
    this.compositionCanceled = false;
    this.compositionText = "";
    this.pendingCompositionInput = null;
  }

  updateComposition(text: string) {
    // WebKitGTK may report an insertCompositionText input before a start event.
    this.compositionActive = true;
    this.compositionText = text;
  }

  cancelComposition() {
    if (this.compositionActive) this.compositionCanceled = true;
  }

  finishComposition(text: string, now = Date.now()) {
    this.compositionActive = false;
    const committedText = this.compositionCanceled ? "" : text || this.compositionText;
    this.compositionText = "";
    this.compositionCanceled = false;
    this.pendingCompositionInput = committedText
      ? { text: committedText, expiresAt: now + 120 }
      : null;
    return committedText || null;
  }

  acceptInput(text: string, event: ImeInputEventState = {}, now = Date.now()) {
    if (
      this.compositionActive ||
      event.isComposing ||
      event.inputType === "insertCompositionText"
    ) {
      return null;
    }

    if (!text) return null;

    const pending = this.pendingCompositionInput;
    this.pendingCompositionInput = null;
    if (
      pending &&
      now <= pending.expiresAt &&
      text === pending.text &&
      (event.inputType === "insertFromComposition" || event.inputType === "insertText" || !event.inputType)
    ) {
      return null;
    }

    return text;
  }

  shouldHandleKey(isComposing: boolean, keyCode: number, key: string) {
    return !(
      this.compositionActive ||
      isComposing ||
      keyCode === 229 ||
      key === "Process" ||
      key === "Unidentified"
    );
  }

  reset() {
    this.compositionActive = false;
    this.compositionCanceled = false;
    this.compositionText = "";
    this.pendingCompositionInput = null;
  }
}
