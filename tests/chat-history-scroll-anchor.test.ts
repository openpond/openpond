import { expect, test } from "vitest";
import { captureChatHistoryAnchor, restoreChatHistoryAnchor } from "../apps/web/src/components/app-shell/chat-history-scroll-anchor";

// History may arrive after more scrolling and concurrent streaming. Preserve the
// reader's row, without counting new content below it or applying anchoring twice.
test("history restoration preserves the current visible row through prepends and native anchoring", () => {
  let rowTop = 200;
  const thread = {
    scrollTop: 220,
    scrollHeight: 2000,
    getBoundingClientRect: () => ({ top: 40 }),
    children: [] as object[],
  };
  const row = {
    parentElement: thread,
    getBoundingClientRect: () => ({ top: 40 + rowTop - thread.scrollTop, bottom: 340 + rowTop - thread.scrollTop }),
  };
  thread.children = [{ getBoundingClientRect: () => ({ top: -400, bottom: -200 }) }, row];
  const element = thread as unknown as HTMLElement;
  expect(captureChatHistoryAnchor(element)?.offset).toBe(-20);

  // The reader continues scrolling while the request is in flight.
  thread.scrollTop = 260;
  const anchor = captureChatHistoryAnchor(element)!;
  expect(anchor.row).toBe(row);
  rowTop += 700;
  thread.scrollHeight += 1200; // 700 above the reader, 500 streamed below.
  restoreChatHistoryAnchor(element, anchor);
  expect(thread.scrollTop).toBe(960);
  expect(captureChatHistoryAnchor(element)?.offset).toBe(-60);

  // Chromium may already have preserved the same position. Do not double shift.
  rowTop += 400;
  thread.scrollTop += 400;
  restoreChatHistoryAnchor(element, anchor);
  expect(thread.scrollTop).toBe(1360);

  // Detached rows from another conversation cannot reposition this viewport.
  row.parentElement = null as unknown as typeof thread;
  rowTop += 100;
  restoreChatHistoryAnchor(element, anchor);
  expect(thread.scrollTop).toBe(1360);
});
