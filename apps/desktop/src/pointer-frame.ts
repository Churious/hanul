export type FrameRequest = (callback: FrameRequestCallback) => number;
export type FrameCancel = (frameId: number) => void;

type PendingFrame<T> = {
  value: T;
  consume: (value: T) => void;
};

/** Keeps only the latest pointer sample and processes it at most once per frame. */
export class LatestFrame<T> {
  private frameId: number | null = null;
  private pending: PendingFrame<T> | null = null;

  constructor(
    private readonly request: FrameRequest = (callback) => requestAnimationFrame(callback),
    private readonly cancel: FrameCancel = (frameId) => cancelAnimationFrame(frameId),
  ) {}

  enqueue(value: T, consume: (value: T) => void) {
    this.pending = { value, consume };
    if (this.frameId !== null) return;
    this.frameId = this.request(() => {
      this.frameId = null;
      const pending = this.pending;
      this.pending = null;
      if (pending) pending.consume(pending.value);
    });
  }

  cancelPending() {
    if (this.frameId !== null) this.cancel(this.frameId);
    this.frameId = null;
    this.pending = null;
  }
}
