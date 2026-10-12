import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WorkspaceDiffFile } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { connectionQueryScope } from "../../lib/query-scope";
import { localFileWorkspaceId } from "../../lib/local-file-workspace";
import { isWorkspaceImagePath } from "../../lib/workspace-images";
import { useAppToast } from "../../app/AppToastContext";
import { RefreshCw } from "../icons";
import { readSandboxFile } from "./workspace-diff-file-model";

export function WorkspaceFileRefresh({ connection, workspaceId, sandboxId, file, dirty, onReload }: {
  connection: ClientConnection | null;
  workspaceId: string | null;
  sandboxId: string | null;
  file: WorkspaceDiffFile;
  dirty: boolean;
  onReload: (file: WorkspaceDiffFile, imageUrl?: string) => void;
}) {
  const sourceId = localFileWorkspaceId(file.path) || workspaceId;
  const toast = useAppToast();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [baseline, setBaseline] = useState<string | null | undefined>(file.readVersion);
  const version = useQuery({
    queryKey: ["open-file-version", connectionQueryScope(connection), sandboxId ?? sourceId, file.path],
    enabled: Boolean(connection && (sandboxId || sourceId)),
    queryFn: async () => {
      if (!sandboxId) return api.workspaceFileVersion(connection!, sourceId!, file.path);
      const parent = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) || "/" : ".";
      const { files } = await api.sandboxFiles(connection!, sandboxId, { path: parent, recursive: false });
      const entry = files.find(entry => entry.path === file.path || entry.path.split("/").pop() === file.path.split("/").pop());
      return { exists: Boolean(entry), revision: entry ? `${entry.sizeBytes}:${entry.updatedAt}` : null };
    },
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (file.readVersion !== undefined) setBaseline(file.readVersion);
    else if (baseline === undefined && version.data) setBaseline(version.data.revision);
  }, [baseline, file.readVersion, version.data]);
  const changed = baseline !== undefined && version.data && baseline !== version.data.revision;

  async function refresh() {
    if (!connection || (!sandboxId && !sourceId) || busy) return;
    if (dirty && !window.confirm("Discard unsaved edits and refresh this file from disk?")) return;
    setBusy(true);
    try {
      const before = await version.refetch();
      if (before.error) throw before.error;
      if (!sandboxId && isWorkspaceImagePath(file.path)) {
        const signed = /^(?:[~/\\]|[A-Za-z]:)/.test(file.path)
          ? await api.signLocalImageUrl(connection, { path: file.path })
          : await api.signWorkspaceImageUrl(connection, { appId: sourceId!, path: file.path });
        const url = new URL(signed.url);
        url.searchParams.set("refresh", String(Date.now()));
        if (!mounted.current) return;
        onReload({ ...file, readVersion: before.data?.revision }, url.href);
      } else {
        const next = sandboxId ? await readSandboxFile(connection, sandboxId, file.path) : await api.workspaceFile(connection, sourceId!, file.path);
        if (!mounted.current) return;
        const image = isWorkspaceImagePath(file.path) && next.contentEncoding === "base64" && next.content
          ? `data:image/${/\.jpe?g$/i.test(file.path) ? "jpeg" : file.path.split(".").pop()};base64,${next.content}` : undefined;
        onReload(next, image);
        setBaseline(next.readVersion ?? before.data?.revision);
      }
      void version.refetch();
    } catch (error) {
      if (mounted.current) toast?.(error instanceof Error ? error.message : "Could not refresh file.", "error");
    } finally { if (mounted.current) setBusy(false); }
  }

  return <button type="button" className={`workspace-file-refresh ${changed ? "updated" : ""}`}
    disabled={busy || !connection || (!sandboxId && !sourceId)} onClick={() => void refresh()}
    aria-label={changed ? "Refresh updated file" : "Refresh file"}
    title={changed ? "The file changed. Refresh to show the latest version." : "Reload this file from disk"}>
    <RefreshCw size={14} className={busy ? "spinning" : undefined} />
    <span>{busy ? "Refreshing…" : "Refresh"}</span>
    {changed ? <span className="workspace-file-refresh-dot" aria-label="Update available" /> : null}
  </button>;
}
