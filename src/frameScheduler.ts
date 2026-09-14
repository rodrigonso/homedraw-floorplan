export function createFrameScheduler() {
  let frame: number | null = null;
  let pending: (() => void) | null = null;
  return {
    schedule(callback: () => void) {
      pending = callback;
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        const run = pending;
        frame = null;
        pending = null;
        run?.();
      });
    },
    cancel() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      pending = null;
    },
  };
}
