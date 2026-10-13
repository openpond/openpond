import { useEffect, useRef, useState } from "react";
import { Camera, X } from "../icons";
import type { BrowserCaptureMode } from "@openpond/contracts/browser-snapshots";

export function BrowserSnapshotMenu({ available, busy, onCapture, onCancel }: {
  available: boolean; busy: boolean; onCapture(mode: BrowserCaptureMode): void; onCancel(): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", key); };
  }, [open]);
  return <div className="browser-menu-anchor" ref={root}>
    <button type="button" title={busy ? "Cancel snapshot" : "Take snapshot"} aria-label={busy ? "Cancel snapshot" : "Take snapshot"}
      disabled={!available && !busy} aria-haspopup={busy ? undefined : "menu"} aria-expanded={open}
      onClick={() => busy ? onCancel() : setOpen(value => !value)}>
      {busy ? <X size={15} /> : <Camera size={15} />}
    </button>
    {open ? <div className="browser-options-menu browser-snapshot-menu" role="menu" aria-label="Snapshot options">
      <button type="button" role="menuitem" onClick={() => { setOpen(false); onCapture("page"); }}>Full page snapshot</button>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); onCapture("node"); }}>Select an element…</button>
    </div> : null}
  </div>;
}
