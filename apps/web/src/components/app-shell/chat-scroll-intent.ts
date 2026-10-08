/** Cancel automatic following before browser scroll events race streaming layout. */
export function observeChatScrollIntent(element: HTMLElement, stopFollowing: () => void): () => void {
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) stopFollowing();
  };
  let touchY: number | null = null;
  const onTouchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (event: TouchEvent) => {
    const nextY = event.touches[0]?.clientY ?? null;
    if (nextY !== null && touchY !== null && nextY > touchY) stopFollowing();
    touchY = nextY;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
      stopFollowing();
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    // Scrollbar dragging needs to take control before the first scroll event.
    if (event.target !== element) return;
    const bounds = element.getBoundingClientRect();
    const scrollbarStart = bounds.left + element.clientLeft + element.clientWidth;
    if (event.clientX >= scrollbarStart) stopFollowing();
  };
  element.addEventListener("wheel", onWheel, { passive: true });
  element.addEventListener("touchstart", onTouchStart, { passive: true });
  element.addEventListener("touchmove", onTouchMove, { passive: true });
  element.addEventListener("keydown", onKeyDown);
  element.addEventListener("pointerdown", onPointerDown);
  return () => {
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchmove", onTouchMove);
    element.removeEventListener("keydown", onKeyDown);
    element.removeEventListener("pointerdown", onPointerDown);
  };
}
