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
  element.addEventListener("wheel", onWheel, { passive: true });
  element.addEventListener("touchstart", onTouchStart, { passive: true });
  element.addEventListener("touchmove", onTouchMove, { passive: true });
  return () => {
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchmove", onTouchMove);
  };
}
