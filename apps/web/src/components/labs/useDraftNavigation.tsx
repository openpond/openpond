import { useEffect, useRef, useState } from "react";
import { AppDialog } from "../dialogs/AppDialog";
import { registerDesktopNavigationGuard } from "./lab-primary-tab-state";

export interface DraftEditorHandle { requestClose: () => void }

/** One draft-exit decision is shared by sidebar, scope picker, Settings and browser history. */
export function useDraftNavigation(input: { dirty: boolean; busy?: boolean; name: string; save?: () => Promise<boolean>; onLeave?: () => void; retainForDestination?: (destination: string) => boolean }) {
  const current = useRef(input);
  current.current = input;
  const pending = useRef<((allowed: boolean) => void) | null>(null);
  const allowNext = useRef(false);
  const mounted = useRef(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function beforeLeave() {
      if (allowNext.current) { allowNext.current = false; return true; }
      if (current.current.busy) return false;
      if (!current.current.dirty) return true;
      if (pending.current) return false;
      setError(null);
      setOpen(true);
      return new Promise<boolean>((resolve) => { pending.current = resolve; });
  }
  useEffect(() => {
    mounted.current = true;
    const unregister = registerDesktopNavigationGuard(async destination => {
      if (current.current.retainForDestination?.(destination) && !current.current.busy) return true;
      const allowed = await beforeLeave();
      if (allowed && mounted.current) current.current.onLeave?.();
      return allowed && mounted.current;
    });
    const beforeUnload = (event: BeforeUnloadEvent) => { if (current.current.dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { mounted.current = false; unregister(); window.removeEventListener("beforeunload", beforeUnload); const callback = pending.current; pending.current = null; callback?.(false); };
  }, []);
  const resolve = (allowed: boolean) => {
    const callback = pending.current;
    pending.current = null;
    if (mounted.current) setOpen(false);
    callback?.(allowed);
  };
  const dialog = open ? <AppDialog ariaLabel={input.save ? `Save ${input.name} before leaving` : `Discard ${input.name}`} className="labs-rename-dialog labs-draft-exit-dialog" backdropClassName="labs-rename-backdrop" dismissDisabled={saving} onClose={() => resolve(false)}>
    <h2>{input.save ? `Save ${input.name} before leaving?` : `Discard ${input.name}?`}</h2>
    <p>{input.save ? "Your changes can be saved before opening the next page." : "This setup has not been saved. Keep editing or discard it to leave."}</p>
    {error ? <p role="alert">{error}</p> : null}
    <div className="model-build-actions">
      <button className="training-button secondary" type="button" disabled={saving} onClick={() => resolve(false)}>Keep editing</button>
      <button className="training-button secondary" type="button" disabled={saving} onClick={() => resolve(true)}>Discard changes</button>
      {input.save ? <button className="training-button" type="button" disabled={saving} onClick={async () => {
        setSaving(true);
        try { const saved = await current.current.save?.(); if (mounted.current) { if (saved) resolve(true); else setError("The draft could not be saved. Your edits are still here."); } }
        catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "The draft could not be saved."); }
        finally { if (mounted.current) setSaving(false); }
      }}>{saving ? "Saving…" : "Save and continue"}</button> : null}
    </div>
  </AppDialog> : null;
  return { dialog, allowNextNavigation() { allowNext.current = true; }, async requestLeave(action: () => void) { if (await beforeLeave() && mounted.current) action(); } };
}
