import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Download } from "../icons";
import { FileBreadcrumbs, workspaceFileDisplayName } from "./WorkspaceFileLocation";

const WordPreview = lazy(() => import("./FilePagePreview"));

export function WorkspaceDocumentPreview({ path, contentBase64 }: { path: string; contentBase64: string }) {
  const filename = workspaceFileDisplayName(path);
  const blob = useMemo(() => {
    try {
      const binary = atob(contentBase64.replace(/\s/g, ""));
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      return new Blob([bytes], { type: documentMimeType(path) });
    } catch { return null; }
  }, [contentBase64, path]);
  const [resource, setResource] = useState<{ blob: Blob; url: string } | null>(null);

  useEffect(() => {
    if (!blob) return;
    // Allocate and release in the same effect. StrictMode replays effects;
    // allocating during render leaves the mounted viewer with a revoked URL.
    const url = URL.createObjectURL(blob);
    setResource({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  // Never let a changed document download the preceding document's bytes while
  // its new URL is being allocated.
  const objectUrl = resource?.blob === blob ? resource.url : null;
  if (!blob) return <div className="workspace-diff-code-empty">Document preview unavailable.</div>;
  if (!objectUrl) return <div className="workspace-diff-code-empty" role="status">Loading document…</div>;

  return <div className="workspace-document-preview">
    <div className="workspace-document-preview-card">
      <FileBreadcrumbs path={path} />
      <div className="workspace-document-preview-actions">
        <span>{/\.pdf$/i.test(path) ? "PDF" : "Word"}</span>
        <a href={objectUrl} download={filename} aria-label="Download document" title="Download document">
          <Download size={16} aria-hidden="true" />
        </a>
      </div>
    </div>
    {/\.docx$/i.test(path) ? <Suspense fallback={<div role="status">Loading document…</div>}>
      <WordPreview thumbnail={false} file={{ path, content: contentBase64, contentEncoding: "base64", status: "", additions: 0, deletions: 0, patch: "" }} />
    </Suspense> : <iframe src={objectUrl} title={`${path} preview`} />}
  </div>;
}

function documentMimeType(path: string): string {
  return /\.pdf$/i.test(path)
    ? "application/pdf"
    : /\.docx$/i.test(path)
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/msword";
}
