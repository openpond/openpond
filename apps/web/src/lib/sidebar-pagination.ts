import { SIDEBAR_CHAT_PAGE_SIZE, SIDEBAR_TASK_INITIAL_LIMIT } from "./app-models";

export function nextSidebarChatVisibleCount(currentCount: number, totalCount: number): number {
  return Math.min(
    Math.max(currentCount, SIDEBAR_TASK_INITIAL_LIMIT) + SIDEBAR_CHAT_PAGE_SIZE,
    totalCount,
  );
}

export function previousSidebarChatVisibleCount(currentCount: number, totalCount: number): number {
  const boundedCount = Math.max(SIDEBAR_TASK_INITIAL_LIMIT, Math.min(currentCount, totalCount));
  if (boundedCount <= SIDEBAR_TASK_INITIAL_LIMIT) return SIDEBAR_TASK_INITIAL_LIMIT;
  const pageCount = Math.ceil((boundedCount - SIDEBAR_TASK_INITIAL_LIMIT) / SIDEBAR_CHAT_PAGE_SIZE);
  return Math.max(
    SIDEBAR_TASK_INITIAL_LIMIT,
    SIDEBAR_TASK_INITIAL_LIMIT + (pageCount - 1) * SIDEBAR_CHAT_PAGE_SIZE,
  );
}
