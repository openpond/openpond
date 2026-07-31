import type { DragEvent } from "react";

export function setSidebarDragImage(event: DragEvent<HTMLDivElement>) {
  const source = event.currentTarget;
  const rect = source.getBoundingClientRect();
  const preview = source.cloneNode(true) as HTMLElement;
  preview.classList.add("sidebar-drag-preview");
  preview.style.width = `${rect.width}px`;
  preview.style.height = `${rect.height}px`;
  preview.style.position = "fixed";
  preview.style.top = "-1000px";
  preview.style.left = "-1000px";
  preview.style.pointerEvents = "none";
  preview.style.boxSizing = "border-box";
  preview.style.maxWidth = "none";
  document.body.appendChild(preview);
  event.dataTransfer.setDragImage(
    preview,
    event.clientX - rect.left,
    event.clientY - rect.top
  );
  window.setTimeout(() => preview.remove(), 0);
}
