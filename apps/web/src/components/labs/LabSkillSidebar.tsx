import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { SkillSourceFile } from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";
import {
  File,
  FileText,
  ImageIcon,
  Loader2,
  Maximize2,
  Minimize2,
  X,
} from "../icons";
import type { LabSkillSourceSelection } from "./lab-skill-source";
import "../../styles/labs/lab-skill-sidebar.css";

export function LabSkillSidebar({
  connection,
  expanded,
  selection,
  onClose,
  onResizeStart,
  onToggleExpanded,
}: {
  connection: ClientConnection | null;
  expanded: boolean;
  selection: LabSkillSourceSelection;
  onClose: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleExpanded: () => void;
}) {
  const selectionKey = `${selection.scope}:${selection.name}`;
  const [selectedFile, setSelectedFile] = useState({
    selectionKey,
    path: selection.files[0] ?? "SKILL.md",
  });
  const selectedPath =
    selectedFile.selectionKey === selectionKey && selection.files.includes(selectedFile.path)
      ? selectedFile.path
      : selection.files[0] ?? "SKILL.md";
  const [source, setSource] = useState<SkillSourceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!connection) {
      setSource(null);
      setError("Connect to the local OpenPond server to load this skill source.");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSource(null);
    void api.skillSourceFile(connection, selection.scope, selection.name, selectedPath)
      .then((payload) => {
        if (!cancelled) setSource(payload);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, selectedPath, selection.name, selection.scope]);

  const fileName = selectedPath.split("/").at(-1) ?? selectedPath;

  return (
    <aside
      className={`workspace-diff-panel native-skill-sidebar lab-skill-sidebar ${expanded ? "expanded" : ""}`}
      aria-label={`Skill package source: ${selection.name}`}
    >
      {!expanded ? (
        <div
          className="workspace-diff-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize skill source"
          onPointerDown={onResizeStart}
        />
      ) : null}
      <div className="workspace-diff-topbar native-skill-sidebar-topbar">
        <div className="workspace-diff-tabs" role="tablist" aria-label="Selected skill file">
          <button className="workspace-diff-tab active" type="button" role="tab" aria-selected>
            <FileIcon path={selectedPath} />
            <span>{fileName}</span>
          </button>
        </div>
        <div className="workspace-diff-toolbar-actions">
          <button
            className="diff-icon-button"
            type="button"
            title={expanded ? "Dock sidebar" : "Expand sidebar"}
            aria-label={expanded ? "Dock sidebar" : "Expand sidebar"}
            onClick={onToggleExpanded}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            className="diff-icon-button"
            type="button"
            title="Close skill source"
            aria-label="Close skill source"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="lab-skill-source-layout">
        <nav className="lab-skill-file-list" aria-label={`${selection.name} package files`}>
          <div className="lab-skill-file-list-heading">Package files</div>
          {selection.files.map((filePath) => (
            <button
              aria-current={filePath === selectedPath ? "page" : undefined}
              className={filePath === selectedPath ? "active" : undefined}
              key={filePath}
              type="button"
              title={filePath}
              onClick={() => setSelectedFile({ selectionKey, path: filePath })}
            >
              <FileIcon path={filePath} />
              <span>{filePath}</span>
            </button>
          ))}
        </nav>
        <div className="native-skill-sidebar-body lab-skill-source-body">
          <header className="native-skill-source-header">
            <div className="lab-skill-source-title-row">
              <h2>{selection.name}</h2>
              <span>{selection.scope === "codex" ? "Codex skill" : "OpenPond skill"}</span>
            </div>
            <p>{selection.description}</p>
            <code>{selection.packagePath}</code>
          </header>
          {loading ? (
            <div className="lab-skill-source-state"><Loader2 className="spin" size={16} /> Loading source…</div>
          ) : error ? (
            <div className="lab-skill-source-state error">{error}</div>
          ) : source?.isBinary ? (
            <div className="lab-skill-source-state">
              <ImageIcon size={18} />
              Binary asset · {formatByteSize(source.byteSize)}
            </div>
          ) : (
            <pre className="native-skill-markdown-source" aria-label={`${fileName} source`}>
              <code>{source?.content ?? ""}</code>
            </pre>
          )}
        </div>
      </div>
    </aside>
  );
}

function FileIcon({ path }: { path: string }) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (["avif", "gif", "jpeg", "jpg", "png", "webp"].includes(extension ?? "")) {
    return <ImageIcon size={14} />;
  }
  if (["md", "txt", "yaml", "yml"].includes(extension ?? "")) {
    return <FileText size={14} />;
  }
  return <File size={14} />;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
