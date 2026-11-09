import { expect, test, vi } from "vitest";
import { retainDevPerformanceMeasures } from "../apps/web/src/lib/dev-performance-retention";

// Unmounting one instrumented subtree must not disable cleanup for another;
// otherwise React's serialized timing props grow without bound again.
test("shares bounded timing retention until the last instrumented view unmounts", () => {
  let deliver!: (count: number) => void;
  const disconnect = vi.fn();
  const clear = vi.spyOn(performance, "clearMeasures");
  vi.stubGlobal("PerformanceObserver", class {
    constructor(callback: (list: { getEntries(): unknown[] }) => void) {
      deliver = count => callback({ getEntries: () => Array.from({ length: count }) });
    }
    observe() {}
    disconnect = disconnect;
  });
  try {
    const stopSidebar = retainDevPerformanceMeasures();
    const stopComposer = retainDevPerformanceMeasures();
    expect(clear).toHaveBeenCalledTimes(1);
    stopComposer();
    expect(disconnect).not.toHaveBeenCalled();
    deliver(1_500);
    expect(clear).toHaveBeenCalledTimes(1);
    deliver(600);
    expect(clear).toHaveBeenCalledTimes(2);
    deliver(2_100);
    expect(clear).toHaveBeenCalledTimes(3);
    stopSidebar();
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
