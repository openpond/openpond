import type { UpdateAppPreferencesRequest } from "@openpond/contracts";
import type { PreferencesPayload } from "../api";

type LayoutPreferencePatch = Pick<UpdateAppPreferencesRequest, "sidebarWidth" | "diffPanelWidth" | "sidebarSectionsCollapsed">;

/** Serialize layout patches; keep only the latest pending value of each field. */
export function createLayoutPreferenceWriter(options: {
  save: (patch: LayoutPreferencePatch) => Promise<PreferencesPayload>;
  apply: (payload: PreferencesPayload) => void;
  onError: (error: unknown) => void;
}) {
  let pending: LayoutPreferencePatch | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;

  function drain(): Promise<void> {
    if (running || !pending || disposed) return running ?? Promise.resolve();
    running = (async () => {
      while (pending && !disposed) {
        const patch = pending;
        pending = null;
        try {
          const payload = await options.save(patch);
          if (!disposed) options.apply(payload);
        } catch (error) {
          if (!disposed) options.onError(error);
        }
      }
    })().finally(() => {
      running = null;
      // A new gesture can arrive after the loop exits but before this callback.
      if (pending && !disposed) return drain();
    });
    return running;
  }

  return {
    write(patch: LayoutPreferencePatch) {
      if (disposed) return Promise.resolve();
      pending = { ...pending, ...patch };
      return drain();
    },
    dispose() {
      disposed = true;
      pending = null;
    },
  };
}

export type LayoutPreferenceWriter = ReturnType<typeof createLayoutPreferenceWriter>;
