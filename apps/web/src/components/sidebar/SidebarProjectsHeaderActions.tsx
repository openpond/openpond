import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Plus } from "../icons";

export function SidebarProjectsHeaderActions({
  onAddProject,
  onViewProjects,
}: {
  onAddProject: () => void;
  onViewProjects: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return (
    <>
      <div
        className="section-menu"
        ref={menuRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
            triggerRef.current?.focus();
          }
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          className={`section-icon${open ? " active" : ""}`}
          aria-label="Project options"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <MoreHorizontal size={14} />
        </button>
        {open ? (
          <div
            className="section-menu-popover"
            role="menu"
            aria-label="Project options"
          >
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onViewProjects(); }}>
              View all projects
            </button>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onAddProject(); }}>
              Add project
            </button>
          </div>
        ) : null}
      </div>
      <button type="button" className="section-icon" onClick={onAddProject} aria-label="Add project" title="Add project">
        <Plus size={18} strokeWidth={2} aria-hidden="true" />
      </button>
    </>
  );
}
