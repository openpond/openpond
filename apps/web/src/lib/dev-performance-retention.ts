const MAX_RETAINED_MEASURES = 2_000;
let observer: PerformanceObserver | null = null;
let consumers = 0;

/** Dev React measures retain serialized props. Keep the entry buffer bounded;
 * recorded DevTools traces and our bounded commit counters remain available. */
export function retainDevPerformanceMeasures(): () => void {
  consumers++;
  if (!observer) {
    let count = 0;
    performance.clearMeasures();
    observer = new PerformanceObserver(list => {
      count += list.getEntries().length;
      if (count >= MAX_RETAINED_MEASURES) {
        performance.clearMeasures();
        count = 0;
      }
    });
    observer.observe({ entryTypes: ["measure"] });
  }
  return () => {
    if (--consumers === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}
