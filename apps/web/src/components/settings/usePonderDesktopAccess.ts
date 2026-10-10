import { useCallback, useEffect, useRef, useState } from "react";
import {
  PonderDesktopProjectPageSchema,
  PonderDesktopProjectSharingResponseSchema,
  type PonderDesktopProjectAuthority,
  type PonderDesktopProjectChoice,
} from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { useErrorToast } from "../../app/AppToastContext";

type DesktopStatus = { state: string; ownerScope: { teamId: string | null } | null };
type Access = {
  desktop: DesktopStatus;
  authority: PonderDesktopProjectAuthority | null;
  projects: PonderDesktopProjectChoice[];
};

function accessError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message === "ponder_desktop_project_authority_changed")
    return "Desktop access changed. Refresh before sharing a project.";
  if (message === "ponder_desktop_project_changed")
    return "The project folders changed. Refresh and review the project before sharing.";
  if (message.length > 240 || /<(?:!doctype|html|body|head)\b/i.test(message))
    return "Ponder desktop access is temporarily unavailable. Please refresh to try again.";
  return message;
}

export function usePonderDesktopAccess(connection: ClientConnection | null) {
  const [access, setAccess] = useState<Access | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  useErrorToast(error);

  const load = useCallback(async (signal?: AbortSignal): Promise<Access> => {
    if (!connection) throw new Error("Connect to the desktop app to share a project.");
    const desktop = await apiFetch<DesktopStatus>(connection, "/v1/ponder/desktop", { signal });
    const projects: PonderDesktopProjectChoice[] = [];
    const cursors = new Set<string>();
    let after: string | null = null;
    let authority: PonderDesktopProjectAuthority | null = null;
    do {
      const page = PonderDesktopProjectPageSchema.parse(await apiFetch(connection,
        `/v1/ponder/desktop/projects${after ? `?after=${encodeURIComponent(after)}` : ""}`, { signal }));
      if (after && JSON.stringify(authority) !== JSON.stringify(page.authority))
        throw new Error("Desktop access changed. Refresh the projects before sharing.");
      authority = page.authority;
      projects.push(...page.projects);
      after = page.nextCursor;
      if (after && cursors.has(after)) throw new Error("Unable to load the complete project list.");
      if (after) cursors.add(after);
    } while (after);
    return { desktop, projects, authority };
  }, [connection]);

  const refresh = useCallback(async () => {
    if (pending.current || !connection) return;
    const version = generation.current;
    pending.current = true;
    setBusy(true);
    setError(null);
    setAccess(null);
    try {
      const value = await load();
      if (generation.current === version) setAccess(value);
    } catch (cause) {
      if (generation.current === version)
        setError(accessError(cause));
    } finally {
      if (generation.current === version) { pending.current = false; setBusy(false); }
    }
  }, [connection, load]);

  useEffect(() => {
    const version = ++generation.current;
    const controller = new AbortController();
    pending.current = true;
    setAccess(null); setError(null); setNotice(null); setBusy(true);
    if (connection) void load(controller.signal)
      .then(value => { if (generation.current === version) setAccess(value); })
      .catch(cause => {
        if (!controller.signal.aborted && generation.current === version)
          setError(accessError(cause));
      })
      .finally(() => {
        if (generation.current === version) { pending.current = false; setBusy(false); }
      });
    else { pending.current = false; setBusy(false); }
    return () => { ++generation.current; controller.abort(); pending.current = false; };
  }, [connection, load]);

  async function change(project: PonderDesktopProjectChoice, shared: boolean) {
    if (!connection || !access?.authority || pending.current) return;
    const version = generation.current;
    pending.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = PonderDesktopProjectSharingResponseSchema.parse(await apiFetch(connection,
        "/v1/ponder/desktop/share-project", { method: "POST", body: JSON.stringify({
          projectId: project.id, shared, expectedRevision: project.revision,
          expectedAuthority: access.authority,
        }) }));
      if (generation.current !== version) return;
      // A mutation can commit even if the following discovery refresh fails.
      setAccess(null);
      setNotice(response.discovery === "pending"
        ? "Project access was saved. Refresh to check whether Ponder has received the updated targets."
        : shared ? `${project.name} is shared with Ponder.` : `${project.name} is no longer shared with Ponder.`);
      const value = await load();
      if (generation.current === version) setAccess(value);
    } catch (cause) {
      if (generation.current === version) {
        setAccess(null);
        setError(accessError(cause));
      }
    } finally {
      if (generation.current === version) { pending.current = false; setBusy(false); }
    }
  }
  return { access, busy, error, notice, refresh, change };
}
