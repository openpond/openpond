import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { WorkspaceDiffFile } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { connectionQueryScope } from "../../lib/query-scope";
import { localFileWorkspaceId } from "../../lib/local-file-workspace";
import { isWorkspaceImagePath } from "../../lib/workspace-images";
import { useWorkspaceImageUrl } from "../../hooks/useWorkspaceImageUrl";
import { FileText } from "../icons";
import { isPresentationFile } from "./workspace-diff-panel-model";
import { readSandboxFile } from "./workspace-diff-file-model";

const PagePreview = lazy(() => import("./FilePagePreview"));
export function WorkspaceFileThumbnail({ path, connection, workspaceId, sandboxId }: {
  path: string;
  connection: ClientConnection | null;
  workspaceId: string | null;
  sandboxId?: string | null;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; file: WorkspaceDiffFile } | null>(null);
  const image = isWorkspaceImagePath(path);
  const sourceId = localFileWorkspaceId(path) || workspaceId;
  const key = `${connectionQueryScope(connection)}:${sourceId}:${sandboxId ?? ""}:${path}`;
  const imageUrl = useWorkspaceImageUrl(connection, visible && image && !sandboxId ? sourceId : null, path);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !connection || (image && !sandboxId) || (!sourceId && !sandboxId)) return;
    let cancelled = false;
    const request = sandboxId ? readSandboxFile(connection, sandboxId, path) : api.workspaceFile(connection, sourceId!, path);
    void request.then(file => { if (!cancelled) setLoaded({ key, file }); }).catch(() => {});
    return () => { cancelled = true; };
  }, [connection, image, key, path, sandboxId, sourceId, visible]);
  const file = loaded?.key === key ? loaded.file : null;
  const sandboxImage = image && sandboxId && file?.contentEncoding === "base64" && file.content
    ? `data:image/${/\.jpe?g$/i.test(path) ? "jpeg" : path.split(".").pop()?.toLowerCase()};base64,${file.content}` : null;
  return <span ref={ref} className="workspace-file-thumbnail">
    {imageUrl || sandboxImage ? <img alt="" src={(imageUrl || sandboxImage)!} loading="lazy" />
      : file?.content && (isPresentationFile(file) || /\.(?:docx|pdf)$/i.test(file.path)) ? <Suspense fallback={<FileText size={28} />}><PagePreview file={file} /></Suspense>
      : file?.content && file.contentEncoding !== "base64" ? <pre>{file.content.slice(0, 1200)}</pre>
      : <FileText size={28} />}
  </span>;
}
