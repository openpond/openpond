import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useAppToast } from "../../app/AppToastContext";
import { copyToClipboard } from "../../lib/clipboard";
import { Copy } from "../icons";

type FilePathMenu = { path: string; title: string; x: number; y: number; trigger: HTMLElement };

export function useFilePathContextMenu() {
  const [menu, setMenu] = useState<FilePathMenu | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const open = useCallback((event: MouseEvent<HTMLElement>, path: string, title = path) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || bounds.left;
    const y = event.clientY || bounds.bottom;
    setMenu({
      path,
      title,
      trigger: event.currentTarget,
      x: Math.max(8, Math.min(x, window.innerWidth - 172)),
      y: Math.max(8, Math.min(y, window.innerHeight - 50)),
    });
  }, []);
  return {
    openFilePathMenu: open,
    filePathMenu: <FilePathContextMenu menu={menu} onClose={close} />,
  };
}

function FilePathContextMenu({
  menu,
  onClose,
}: {
  menu: FilePathMenu | null;
  onClose: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const showToast = useAppToast();
  useEffect(() => {
    if (!menu) return;
    buttonRef.current?.focus();
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        menu.trigger.focus();
        close();
      } else if (event.key === "Tab") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu, onClose]);

  if (!menu || typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-label={`${menu.title} file actions`}
      className="activity-artifact-context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        ref={buttonRef}
        role="menuitem"
        type="button"
        onClick={() => {
          void copyToClipboard(menu.path).then((copied) => {
            if (!copied) showToast?.("Could not copy this file path.", "error");
          });
          menu.trigger.focus();
          onClose();
        }}
      >
        <Copy aria-hidden size={14} />
        <span>Copy path</span>
      </button>
    </div>,
    document.body,
  );
}
