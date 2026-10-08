import { messageScrollTop } from "./main-pane-helpers";

export type SentMessageAnchor = { row: HTMLElement; following: boolean };

// Four normal transcript lines remain visible above the new request.
export const SENT_MESSAGE_TOP_SPACE_PX = 96;

export function reserveSentMessageSpace(element: HTMLElement, anchor: SentMessageAnchor): number | null {
  if (!anchor.row.isConnected || anchor.row.parentElement !== element) return null;
  const previousSpace = Number.parseFloat(element.style.getPropertyValue("--chat-sent-message-space")) || 0;
  const basePadding = Number.parseFloat(getComputedStyle(element).paddingBottom) - previousSpace;
  const lastRow = element.lastElementChild as HTMLElement | null;
  const belowRequest = lastRow
    ? lastRow.getBoundingClientRect().bottom - anchor.row.getBoundingClientRect().top + basePadding
    : basePadding;
  const space = Math.max(0, element.clientHeight - SENT_MESSAGE_TOP_SPACE_PX - belowRequest);
  if (Math.abs(space - previousSpace) > 0.5) element.style.setProperty("--chat-sent-message-space", `${space}px`);
  return Math.max(0, messageScrollTop(element, anchor.row) - SENT_MESSAGE_TOP_SPACE_PX);
}
