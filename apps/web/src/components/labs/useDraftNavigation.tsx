import { useEffect, useRef, useState } from "react";
import { AppDialog } from "../dialogs/AppDialog";
import { registerDesktopNavigationGuard } from "./lab-primary-tab-state";

/** One draft-exit decision is shared by sidebar, scope picker, Settings and browser history. */
export function useDraftNavigation(input: { dirty: boolean; busy?: boolean; name: string; save?: () => Promise<boolean>; onLeave?: () => void }) {
  const current = useRef(input);
  current.current = input;
  const pending = useRef<((allowed: boolean) => void) | null>(null);
  const allowNext = useRef(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function beforeLeave() {
      if (allowNext.current) { allowNext.current = false; return true; }
      if (current.current.busy) return false;
      if (!current.current.dirty) { current.current.onLeave?.(); return true; }
      if (pending.current) return false;
      setError(null);
      setOpen(true);
      return new Promise<boolean>((resolve) => { pending.current = resolve; });
  }
  useEffect(() => {
    const unregister = registerDesktopNavigationGuard(beforeLeave);
    const beforeUnload = (event: BeforeUnloadEvent) => { if (current.current.dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { unregister(); window.removeEventListener("beforeunload", beforeUnload); pending.current?.(false); pending.current = null; };
  }, []);
  const resolve = (allowed: boolean) => {
    if (allowed) current.current.onLeave?.();
    const callback = pending.current;
    pending.current = null;
    setOpen(false);
    callback?.(allowed);
  };
  const dialog = open ? <AppDialog ariaLabel={input.save ? `Save ${input.name} before leaving` : `Discard ${input.name}`} className="labs-rename-dialog" backdropClassName="labs-rename-backdrop" dismissDisabled={saving} onClose={() => resolve(false)}>
    <h2>{input.save ? `Save ${input.name} before leaving?` : `Discard ${input.name}?`}</h2>
    <p>{input.save ? "Your changes can be saved before opening the next page." : "This setup has not been saved. Keep editing or discard it to leave."}</p>
    {error ? <p role="alert">{error}</p> : null}
    <div className="model-build-actions">
      <button className="training-button secondary" type="button" disabled={saving} onClick={() => resolve(false)}>Keep editing</button>
      <button className="training-button secondary" type="button" disabled={saving} onClick={() => resolve(true)}>Discard changes</button>
      {input.save ? <button className="training-button" type="button" disabled={saving} onClick={async () => {
        setSaving(true);
        try { if (await current.current.save?.()) resolve(true); else setError("The draft could not be saved. Your edits are still here."); }
        catch (error) { setError(error instanceof Error ? error.message : "The draft could not be saved."); }
        finally { setSaving(false); }
      }}>{saving ? "Saving…" : "Save and continue"}</button> : null}
    </div>
  </AppDialog> : null;
  return { dialog, allowNextNavigation() { allowNext.current = true; }, async requestLeave(action: () => void) { if (await beforeLeave()) action(); } };
}
