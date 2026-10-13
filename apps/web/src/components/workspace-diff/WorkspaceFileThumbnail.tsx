import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ClientConnection } from "../../api";
import { connectionQueryScope } from "../../lib/query-scope";
import { localFileWorkspaceId } from "../../lib/local-file-workspace";
import { isWorkspaceImagePath } from "../../lib/workspace-images";
import { useWorkspaceImageUrl } from "../../hooks/useWorkspaceImageUrl";
import { FileText } from "../icons";
import { isPresentationFile } from "./workspace-diff-panel-model";
import { readSandboxFile } from "./workspace-diff-file-model";

const PagePreview = lazy(() => import("./FilePagePreview"));
export function WorkspaceFileThumbnail({ path, connection, workspaceId, sandboxId, revision }: {
  revision?: string;
  path: string;
  connection: ClientConnection | null;
  workspaceId: string | null;
  sandboxId?: string | null;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
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
  const loaded = useQuery({
    queryKey: ["file-thumbnail", key, revision],
    enabled: Boolean(visible && connection && (!image || sandboxId) && (sourceId || sandboxId)),
    queryFn: () => sandboxId ? readSandboxFile(connection!, sandboxId, path) : api.workspaceFile(connection!, sourceId!, path),
    staleTime: revision ? Infinity : 15_000,
    gcTime: 60_000,
  });
  const file = loaded.data;
  const sandboxImage = image && sandboxId && file?.contentEncoding === "base64" && file.content
    ? `data:image/${/\.jpe?g$/i.test(path) ? "jpeg" : path.split(".").pop()?.toLowerCase()};base64,${file.content}` : null;
  return <span ref={ref} className="workspace-file-thumbnail">
    {imageUrl || sandboxImage ? <img alt="" src={(imageUrl || sandboxImage)!} loading="lazy" />
      : file?.content && (isPresentationFile(file) || /\.(?:docx|pdf)$/i.test(file.path)) ? <Suspense fallback={<FileText size={28} />}><PagePreview file={file} /></Suspense>
      : file?.content && file.contentEncoding !== "base64" ? <pre>{file.content.slice(0, 1200)}</pre>
      : <FileText size={28} />}
  </span>;
}
