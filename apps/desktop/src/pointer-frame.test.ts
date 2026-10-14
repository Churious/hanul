import { describe, expect, it, vi } from "vitest";
import { LatestFrame, type FrameCancel, type FrameRequest } from "./pointer-frame";

function fakeFrames() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const request: FrameRequest = (callback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  };
  const cancel: FrameCancel = (id) => { callbacks.delete(id); };
  const runNext = (time = 16) => {
    const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) return false;
    callbacks.delete(entry[0]);
    entry[1](time);
    return true;
  };
  return { request, cancel, runNext, callbacks };
}

describe("LatestFrame", () => {
  it("coalesces pointer samples to the latest value for one frame", () => {
    const frames = fakeFrames();
    const processed: number[] = [];
    const consume = vi.fn((value: number) => processed.push(value));
    const latestFrame = new LatestFrame<number>(frames.request, frames.cancel);

    latestFrame.enqueue(1, consume);
    latestFrame.enqueue(2, consume);
    latestFrame.enqueue(3, consume);

    expect(frames.callbacks.size).toBe(1);
    expect(frames.runNext()).toBe(true);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(processed).toEqual([3]);
  });

  it("cancels a pending frame when the pointer gesture ends", () => {
    const frames = fakeFrames();
    const consume = vi.fn();
    const latestFrame = new LatestFrame<{ x: number }>(frames.request, frames.cancel);
    latestFrame.enqueue({ x: 12 }, consume);

    latestFrame.cancelPending();

    expect(frames.callbacks.size).toBe(0);
    expect(consume).not.toHaveBeenCalled();
  });
});
