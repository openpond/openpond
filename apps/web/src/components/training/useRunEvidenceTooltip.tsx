import { useEffect, useId, useState, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";

/** Matches the shell's floating evidence popovers, for both SVG and HTML controls. */
export function useRunEvidenceTooltip(content: ReactNode) {
  const id = useId();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const show = (event: SyntheticEvent<Element>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 292)),
      top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 168)),
    });
  };
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", key);
    };
  }, [position]);
  return {
    hideTooltip: () => setPosition(null),
    triggerProps: {
      "aria-describedby": position ? id : undefined,
      onPointerEnter: show,
      onPointerLeave: () => setPosition(null),
      onFocus: show,
      onBlur: () => setPosition(null),
    },
    tooltip: position
      ? createPortal(
          <aside role="tooltip" id={id} className="run-evidence-tooltip" style={position}>
            {content}
          </aside>,
          document.body,
        )
      : null,
  };
}
