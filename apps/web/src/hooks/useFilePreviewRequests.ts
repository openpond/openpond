import { useEffect, useRef } from "react";
import { FilePreviewRequestSchema } from "@openpond/contracts/runtime";
import type { RuntimeEventStore } from "../lib/runtime-event-store";

export type FilePreviewOpenOptions = { source?: boolean; local?: boolean; sandboxId?: string | null };

/** Subscribe only to live events: loading history or switching chats must not reopen files. */
export function useFilePreviewRequests(
  store: RuntimeEventStore,
  sessionId: string | null,
  openFile: (path: string, options?: FilePreviewOpenOptions) => void,
) {
  const latest = useRef({ sessionId, openFile });
  latest.current = { sessionId, openFile };
  useEffect(() => store.subscribeLive(events => {
    for (const event of events) {
      if (!latest.current.sessionId || event.sessionId !== latest.current.sessionId
        || event.name !== "file.preview_requested" || event.source !== "server") continue;
      const parsed = FilePreviewRequestSchema.safeParse(event.data);
      if (!parsed.success) continue;
      const request = parsed.data;
      latest.current.openFile(request.path, request.target === "local"
        ? { source: request.source, local: true }
        : { source: request.source, sandboxId: request.sandboxId });
    }
  }), [store]);
}
