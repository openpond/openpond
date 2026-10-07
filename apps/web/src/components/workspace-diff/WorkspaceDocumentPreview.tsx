import { useEffect, useMemo, useState } from "react";
import { Download } from "../icons";

export function WorkspaceDocumentPreview({ path, contentBase64 }: { path: string; contentBase64: string }) {
  const filename = path.replace(/\\/g, "/").split("/").pop() || "document";
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
      <strong>{filename}</strong>
      <span>{/\.pdf$/i.test(path) ? "PDF document" : "Word document"}</span>
      <a href={objectUrl} download={filename} aria-label="Download document" title="Download document">
        <Download size={16} aria-hidden="true" />
      </a>
    </div>
    <iframe src={objectUrl} title={`${path} preview`} />
  </div>;
}

function documentMimeType(path: string): string {
  return /\.pdf$/i.test(path)
    ? "application/pdf"
    : /\.docx$/i.test(path)
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/msword";
}
