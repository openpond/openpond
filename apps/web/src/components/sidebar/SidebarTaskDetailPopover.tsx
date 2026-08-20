import { useEffect, type CSSProperties } from "react";

const TASK_DETAIL_POPOVER_WIDTH = 288;
const TASK_DETAIL_POPOVER_ESTIMATED_HEIGHT = 112;

export type SidebarTaskDetail = {
  descriptionId: string;
  projectLabel: string;
  sessionId: string;
  title: string;
  updatedAt: string;
  style: CSSProperties;
};

export function sidebarTaskDetailPosition(
  rect: Pick<DOMRect, "right" | "top">,
  viewport: { width: number; height: number },
): CSSProperties {
  const maxLeft = Math.max(12, viewport.width - TASK_DETAIL_POPOVER_WIDTH - 12);
  const maxTop = Math.max(12, viewport.height - TASK_DETAIL_POPOVER_ESTIMATED_HEIGHT - 12);
  return {
    "--sidebar-task-detail-left": `${Math.round(Math.max(12, Math.min(rect.right + 10, maxLeft)))}px`,
    "--sidebar-task-detail-top": `${Math.round(Math.max(12, Math.min(rect.top - 4, maxTop)))}px`,
  } as CSSProperties;
}

export function SidebarTaskDetailPopover({
  detail,
  onClose,
}: {
  detail: SidebarTaskDetail | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!detail || typeof window === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    let scrollListenerAttached = false;
    const attachScrollListenerFrame = window.requestAnimationFrame(() => {
      window.addEventListener("scroll", onClose, true);
      scrollListenerAttached = true;
    });
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(attachScrollListenerFrame);
      window.removeEventListener("keydown", handleKeyDown);
      if (scrollListenerAttached) window.removeEventListener("scroll", onClose, true);
    };
  }, [detail, onClose]);

  if (!detail) return null;
  const updated = new Date(detail.updatedAt);
  const exactUpdatedAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "short",
  }).format(updated);

  return (
    <aside
      id={detail.descriptionId}
      className="sidebar-task-detail-popover"
      style={detail.style}
      aria-label={`${detail.title} details`}
    >
      <div className="sidebar-task-detail-title">{detail.title}</div>
      <div className="sidebar-task-detail-project">{detail.projectLabel}</div>
      <time dateTime={detail.updatedAt}>{exactUpdatedAt}</time>
    </aside>
  );
}
