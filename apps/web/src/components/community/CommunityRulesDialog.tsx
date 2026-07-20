import type { CommunityRuleVersion } from "@openpond/contracts";
import { useEffect, useRef, useState } from "react";
import { MarkdownText } from "../chat/MarkdownText";
import { X } from "../icons";

export function CommunityRulesDialog(props: {
  rules: CommunityRuleVersion;
  mode: "join" | "reaccept" | "review";
  busy: boolean;
  onAccept: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(props.onClose);
  useEffect(() => setAccepted(false), [props.rules.id]);
  useEffect(() => { onCloseRef.current = props.onClose; }, [props.onClose]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])];
    focusable()[0]?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("keydown", keyDown);
      previous?.focus();
    };
  }, []);
  const requiresAction = props.mode !== "review";
  return (
    <div className="community-dialog-backdrop" role="presentation" onMouseDown={props.onClose}>
      <section
        ref={dialogRef}
        className="community-rules-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="community-rules-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <small>Community rules · version {props.rules.version}</small>
            <h2 id="community-rules-title">{props.rules.title}</h2>
          </div>
          <button type="button" aria-label="Close rules" onClick={props.onClose}><X size={16} /></button>
        </header>
        <div className="community-rules-body"><MarkdownText content={props.rules.bodyMarkdown} /></div>
        <footer>
          {requiresAction ? (
            <label className="community-rules-acceptance">
              <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.currentTarget.checked)} />
              <span>I have read and agree to follow these rules.</span>
            </label>
          ) : <span />}
          <div>
            <button type="button" className="secondary" onClick={props.onClose}>Cancel</button>
            {requiresAction ? (
              <button
                type="button"
                disabled={!accepted || props.busy}
                onClick={() => void props.onAccept().then((joined) => { if (joined) props.onClose(); })}
              >
                {props.busy ? "Saving…" : props.mode === "join" ? "Agree and join" : "Accept updated rules"}
              </button>
            ) : null}
          </div>
        </footer>
      </section>
    </div>
  );
}
