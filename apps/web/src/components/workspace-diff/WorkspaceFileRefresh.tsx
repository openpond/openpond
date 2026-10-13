import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WorkspaceDiffFile } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { connectionQueryScope } from "../../lib/query-scope";
import { localFileWorkspaceId } from "../../lib/local-file-workspace";
import { fileContentVersion } from "../../lib/file-content-version";
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
  const [comparisonReady, setComparisonReady] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [baseline, setBaseline] = useState<string | null | undefined>(file.readVersion);
  const sandboxVersion = useRef<{ stamp: string; revision: string | null | undefined } | null>(null);
  const version = useQuery({
    queryKey: ["open-file-version", connectionQueryScope(connection), sandboxId ?? sourceId, file.path],
    enabled: Boolean(connection && (sandboxId || sourceId)),
    queryFn: async () => {
      if (!sandboxId) return api.workspaceFileVersion(connection!, sourceId!, file.path);
      const parent = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) || "/" : ".";
      const { files } = await api.sandboxFiles(connection!, sandboxId, { path: parent, recursive: false });
      const entry = files.find(entry => entry.path === file.path || entry.path.split("/").pop() === file.path.split("/").pop());
      if (!entry) return { exists: false, revision: null };
      const stamp = `${entry.sizeBytes}:${entry.updatedAt}`;
      if (file.readStamp === stamp) return { exists: true, revision: file.readVersion ?? null };
      if (sandboxVersion.current?.stamp === stamp) return { exists: true, revision: sandboxVersion.current.revision ?? null };
      const current = await readSandboxFile(connection!, sandboxId, file.path);
      sandboxVersion.current = { stamp, revision: current.readVersion };
      return { exists: true, revision: current.readVersion ?? null };
    },
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });
  const checkVersion = version.refetch;
  useEffect(() => {
    let cancelled = false;
    setComparisonReady(false);
    void (async () => {
      const digest = file.contentEncoding === "base64" && file.content
        ? await fileContentVersion(file.content) : file.readVersion;
      if (cancelled) return;
      setBaseline(digest);
      if (connection && (sandboxId || sourceId)) await checkVersion();
      if (!cancelled) setComparisonReady(true);
    })().catch(() => { if (!cancelled) setComparisonReady(true); });
    return () => { cancelled = true; };
  }, [checkVersion, connection, file.content, file.contentEncoding, file.readVersion, sandboxId, sourceId]);

  useEffect(() => {
    if (baseline === undefined && !file.content && version.data) setBaseline(version.data.revision);
  }, [baseline, file.content, version.data]);
  const changed = comparisonReady && baseline !== undefined && !version.isError && version.data?.exists && baseline !== version.data.revision;

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

  if (!changed && !busy) return null;
  return <button type="button" className="workspace-file-refresh"
    disabled={busy || !connection || (!sandboxId && !sourceId)} onClick={() => void refresh()}
    aria-label="Reload updated file"
    title={changed ? "The file changed. Reload to show the latest version." : "Reload this file from disk"}>
    <RefreshCw size={14} className={busy ? "spinning" : undefined} />
    <span>{busy ? "Reloading…" : "Reload"}</span>
  </button>;
}
