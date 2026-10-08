export type ChatHistoryScrollAnchor = {
  row: Element;
  offset: number;
};

/** Keep a visible row fixed, rather than treating all transcript growth as a prepend. */
export function captureChatHistoryAnchor(element: HTMLElement): ChatHistoryScrollAnchor | null {
  const top = element.getBoundingClientRect().top;
  for (const row of Array.from(element.children)) {
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom <= top) continue;
    return { row, offset: bounds.top - top };
  }
  return null;
}

export function restoreChatHistoryAnchor(element: HTMLElement, anchor: ChatHistoryScrollAnchor): void {
  if (anchor.row.parentElement !== element) return;
  const offset = anchor.row.getBoundingClientRect().top - element.getBoundingClientRect().top;
  element.scrollTop += offset - anchor.offset;
}
