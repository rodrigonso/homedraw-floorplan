import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameScheduler } from "./frameScheduler";

let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  frames = new Map();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.set(++id, callback); return id; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
});
afterEach(() => vi.unstubAllGlobals());
const tick = () => {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(0));
};

describe("frame-coalesced previews", () => {
  it("runs only the latest preview once per frame", () => {
    const scheduler = createFrameScheduler();
    const first = vi.fn(), latest = vi.fn();
    scheduler.schedule(first);
    scheduler.schedule(latest);
    expect(frames.size).toBe(1);
    expect(latest).not.toHaveBeenCalled();
    tick();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    tick();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("discards pending previews on release, cancellation, tool change or unmount", () => {
    const scheduler = createFrameScheduler(), preview = vi.fn();
    scheduler.schedule(preview);
    scheduler.cancel();
    scheduler.cancel();
    tick();
    expect(preview).not.toHaveBeenCalled();
    scheduler.schedule(preview);
    tick();
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("allows new work scheduled by a callback to run on the following frame", () => {
    const scheduler = createFrameScheduler(), next = vi.fn();
    scheduler.schedule(() => scheduler.schedule(next));
    tick();
    expect(next).not.toHaveBeenCalled();
    tick();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
