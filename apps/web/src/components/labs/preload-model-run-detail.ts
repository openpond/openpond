/** Start the existing split chunk on pointer/focus intent, before navigation. */
export function preloadModelRunDetail() {
  void import("./LabModelVersionDetailPage").catch(() => undefined);
}
