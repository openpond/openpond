import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { ChevronRight, ChevronUp } from "../icons";
import type { WorkspaceDiffFile, WorkspaceLspActionResponse, WorkspaceLspDiagnostic } from "@openpond/contracts";
import { SyntaxLine, languageForPath } from "../chat/workspaceSyntax";
import { MarkdownText } from "../chat/MarkdownText";
import {
  isAbsoluteWorkspaceDiffPath,
  isDocumentPath,
  isMarkdownPath,
  normalizeWorkspaceDiffPath,
} from "./workspace-diff-panel-model";
import type { WorkspaceMonacoEditorHandle, WorkspaceMonacoLspActionInput } from "./WorkspaceMonacoEditor";
import { useErrorToast } from "../../app/AppToastContext";

const FILE_TRUNCATED_MARKER = "\n\n[file truncated]";
const MonacoFileEditor = lazy(() => import("./WorkspaceMonacoEditor"));
const PATCH_CONTEXT_EDGE_LINES = 6;
const PATCH_CONTEXT_FOLD_MIN_LINES = 18;
const DIFF_ROW_HEIGHT = 22;
const DIFF_DEFAULT_VIEWPORT_ROWS = 44;
const DIFF_VIRTUALIZE_THRESHOLD = 160;
const DIFF_VIRTUAL_OVERSCAN_ROWS = 12;

function FileBreadcrumbs({
  path,
  workspaceName,
  workspaceRootPath,
  onSelectPath,
}: {
  path: string;
  workspaceName: string | null;
  workspaceRootPath?: string | null;
  onSelectPath?: (path: string | null) => void;
}) {
  const displayPath = normalizeWorkspaceDiffPath(path, workspaceRootPath);
  const absolute = isAbsoluteWorkspaceDiffPath(displayPath);
  const root = absolute ? absoluteBreadcrumbRoot(displayPath) : workspaceName?.trim() || "Workspace";
  const pathWithoutAbsoluteRoot = absolute && root !== "/" && displayPath.startsWith(`${root}/`)
    ? displayPath.slice(root.length + 1)
    : displayPath;
  const parts = pathWithoutAbsoluteRoot.split("/").filter(Boolean);
  const selectableFolders = Boolean(onSelectPath && !absolute);
  return (
    <span className="workspace-file-breadcrumbs" title={absolute ? displayPath : `${root} > ${displayPath}`}>
      {onSelectPath && !absolute ? (
        <button type="button" onClick={() => onSelectPath(null)}>
          {root}
        </button>
      ) : (
        <span>{root}</span>
      )}
      {parts.map((part, index) => {
        const isFileName = index === parts.length - 1;
        const folderPath = parts.slice(0, index + 1).join("/");
        return (
          <span className="workspace-file-breadcrumb-segment" key={`${index}-${part}`}>
            <ChevronRight size={13} />
            {onSelectPath && selectableFolders && !isFileName ? (
              <button type="button" onClick={() => onSelectPath(folderPath)}>
                {part}
              </button>
            ) : (
              <span>{part}</span>
            )}
          </span>
        );
      })}
    </span>
  );
}

function absoluteBreadcrumbRoot(path: string): string {
  const windowsDrive = /^[A-Za-z]:\//.exec(path);
  return windowsDrive ? windowsDrive[0].slice(0, -1) : "/";
}

export function FilePreview({
  collapsed = false,
  diagnostics = [],
  draftContent,
  editable = false,
  editorRef,
  error,
  file,
  hideWhiteSpace = false,
  headerActions,
  imageSrc,
  loading,
  loadFullFiles,
  onOpenImage,
  onSelectBreadcrumbPath,
  onDraftContentChange,
  onLspAction,
  onSave,
  renderMarkdown,
  saveError,
  saving = false,
  splitView = false,
  wordDiffs = false,
  wordWrap,
  workspaceName,
  workspaceRootPath,
}: {
  collapsed?: boolean;
  diagnostics?: WorkspaceLspDiagnostic[];
  draftContent?: string;
  editorRef?: Ref<WorkspaceMonacoEditorHandle>;
  editable?: boolean;
  error: string | null;
  file: WorkspaceDiffFile;
  hideWhiteSpace?: boolean;
  headerActions?: ReactNode;
  imageSrc?: string | null;
  loading: boolean;
  loadFullFiles: boolean;
  onOpenImage?: () => void;
  onSelectBreadcrumbPath?: (path: string | null) => void;
  onDraftContentChange?: (content: string) => void;
  onLspAction?: (input: WorkspaceMonacoLspActionInput) => Promise<WorkspaceLspActionResponse>;
  onSave?: () => void;
  renderMarkdown: boolean;
  saveError?: string | null;
  saving?: boolean;
  splitView?: boolean;
  wordDiffs?: boolean;
  wordWrap: boolean;
  workspaceName: string | null;
  workspaceRootPath?: string | null;
}) {
  useErrorToast(error, { prefix: "File preview" });
  useErrorToast(saveError, { prefix: "Save failed" });
  const displayContent = draftContent ?? file.content ?? "";
  const lines = useMemo(() => displayContent.split("\n").slice(0, 800), [displayContent]);
  const language = languageForPath(file.path);
  const hasContent = draftContent != null || file.content != null;
  const contentIsTruncated = displayContent.endsWith(FILE_TRUNCATED_MARKER);
  const shouldRenderMarkdown = renderMarkdown && hasContent && isMarkdownPath(file.path);
  const shouldRenderDocument = hasContent && isDocumentPath(file.path) && isLikelyBase64Document(displayContent);

  if (imageSrc) {
    return (
      <div className="workspace-file-preview">
        <div className="workspace-diff-file-heading">
          <div>
            <FileBreadcrumbs
              path={file.path}
              workspaceName={workspaceName}
              workspaceRootPath={workspaceRootPath}
              onSelectPath={onSelectBreadcrumbPath}
            />
            <span className="diff-addition">+{file.additions}</span>
            <span className="diff-deletion">-{file.deletions}</span>
          </div>
          {headerActions}
        </div>
        <div className="workspace-file-image-stage">
          <button
            type="button"
            className="workspace-file-image-button"
            aria-label={`Open image preview for ${file.path}`}
            onClick={onOpenImage}
          >
            <img alt={file.path} decoding="async" src={imageSrc} />
          </button>
        </div>
      </div>
    );
  }
  if ((!loadFullFiles && file.patch) || (!hasContent && file.patch)) {
    return splitView ? (
      <SplitDiffPreview
        collapsed={collapsed}
        file={file}
        hideWhiteSpace={hideWhiteSpace}
        onSelectBreadcrumbPath={onSelectBreadcrumbPath}
        wordDiffs={wordDiffs}
        wordWrap={wordWrap}
        headerActions={headerActions}
        workspaceName={workspaceName}
        workspaceRootPath={workspaceRootPath}
      />
    ) : (
      <UnifiedDiffPreview
        collapsed={collapsed}
        file={file}
        hideWhiteSpace={hideWhiteSpace}
        wordWrap={wordWrap}
        workspaceName={workspaceName}
        workspaceRootPath={workspaceRootPath}
        onSelectBreadcrumbPath={onSelectBreadcrumbPath}
        headerActions={headerActions}
      />
    );
  }
  return (
    <div className={`workspace-file-preview ${wordWrap ? "wrap" : ""}`}>
      <div className="workspace-diff-file-heading">
        <div>
          <FileBreadcrumbs
            path={file.path}
            workspaceName={workspaceName}
            workspaceRootPath={workspaceRootPath}
            onSelectPath={onSelectBreadcrumbPath}
          />
          <span className="diff-addition">+{file.additions}</span>
          <span className="diff-deletion">-{file.deletions}</span>
        </div>
        <span className="workspace-file-heading-end">
          {saving ? <span className="workspace-file-save-state">Saving</span> : null}
          {headerActions}
        </span>
      </div>
      {!hasContent ? (
        <div className="workspace-diff-code-empty">{loading ? "Loading file content" : "No file content available."}</div>
      ) : shouldRenderMarkdown ? (
        <div className="workspace-markdown-preview">
          <MarkdownText content={displayContent} />
        </div>
      ) : shouldRenderDocument ? (
        <DocumentPreview file={file} contentBase64={displayContent} />
      ) : editable && !contentIsTruncated ? (
        <Suspense fallback={<div className="workspace-diff-code-empty">Loading editor</div>}>
          <MonacoFileEditor
            diagnostics={diagnostics}
            filePath={file.path}
            onChange={(content) => onDraftContentChange?.(content)}
            onLspAction={onLspAction}
            onSave={() => onSave?.()}
            ref={editorRef}
            value={displayContent}
            wordWrap={wordWrap}
          />
        </Suspense>
      ) : (
        <div className="workspace-file-code">
          {lines.map((line, index) => (
            <div className="workspace-file-code-row" key={`${index}-${line}`}>
              <span>{index + 1}</span>
              <code>
                <SyntaxLine language={language} text={line || " "} />
              </code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function UnifiedDiffPreview({
  collapsed = false,
  file,
  hideWhiteSpace = false,
  wordWrap,
  workspaceName,
  workspaceRootPath,
  onSelectBreadcrumbPath,
  headerActions,
}: {
  collapsed?: boolean;
  file: WorkspaceDiffFile;
  hideWhiteSpace?: boolean;
  wordWrap: boolean;
  workspaceName?: string | null;
  workspaceRootPath?: string | null;
  onSelectBreadcrumbPath?: (path: string | null) => void;
  headerActions?: ReactNode;
}) {
  const rows = useMemo(() => parsePatchRows(file.patch, hideWhiteSpace), [file.patch, hideWhiteSpace]);
  const language = languageForPath(file.path);
  return (
    <div className={`workspace-diff-preview ${wordWrap ? "wrap" : ""}`}>
      <div className="workspace-diff-file-heading">
        <div>
          <FileBreadcrumbs
            path={file.path}
            workspaceName={workspaceName ?? null}
            workspaceRootPath={workspaceRootPath}
            onSelectPath={onSelectBreadcrumbPath}
          />
          <span className="diff-addition">+{file.additions}</span>
          <span className="diff-deletion">-{file.deletions}</span>
        </div>
        {headerActions}
      </div>
      {collapsed ? (
        <div className="workspace-diff-code-empty">Diff collapsed</div>
      ) : (
        <VirtualizedDiffRows
          ariaLabel={`${file.path} diff`}
          className="workspace-diff-code"
          emptyMessage="No patch available."
          rows={rows}
          renderRow={(row, index) =>
            row.kind === "spacer" ? (
              <div className="workspace-diff-spacer" key={`${row.label}-${index}`} role="row">
                {row.label}
              </div>
            ) : (
              <div className={`workspace-diff-code-row ${row.kind}`} key={`${row.oldLine}-${row.newLine}-${index}`} role="row">
                <span className="workspace-diff-line-number" role="cell">
                  {row.newLine || row.oldLine}
                </span>
                <code role="cell">
                  <SyntaxLine language={language} text={row.newContent || row.oldContent || " "} />
                </code>
              </div>
            )
          }
          wordWrap={wordWrap}
        />
      )}
    </div>
  );
}

export function SplitDiffPreview({
  collapsed,
  file,
  hideWhiteSpace,
  wordDiffs,
  wordWrap,
  workspaceName,
  workspaceRootPath,
  onSelectBreadcrumbPath,
  headerActions,
}: {
  collapsed: boolean;
  file: WorkspaceDiffFile;
  hideWhiteSpace: boolean;
  wordDiffs: boolean;
  wordWrap: boolean;
  workspaceName: string | null;
  workspaceRootPath?: string | null;
  onSelectBreadcrumbPath?: (path: string | null) => void;
  headerActions?: ReactNode;
}) {
  const rows = useMemo(() => parsePatchRows(file.patch, hideWhiteSpace), [file.patch, hideWhiteSpace]);
  const language = languageForPath(file.path);
  return (
    <div className={`workspace-diff-preview split ${wordWrap ? "wrap" : ""} ${wordDiffs ? "word-diffs" : ""}`}>
      <div className="workspace-diff-file-heading">
        <div>
          <FileBreadcrumbs
            path={file.path}
            workspaceName={workspaceName}
            workspaceRootPath={workspaceRootPath}
            onSelectPath={onSelectBreadcrumbPath}
          />
          <span className="diff-addition">+{file.additions}</span>
          <span className="diff-deletion">-{file.deletions}</span>
        </div>
        <span className="workspace-file-heading-end">
          {headerActions}
          <ChevronUp size={14} />
        </span>
      </div>
      {collapsed ? (
        <div className="workspace-diff-code-empty">Diff collapsed</div>
      ) : (
        <VirtualizedDiffRows
          ariaLabel={`${file.path} split diff`}
          className="workspace-split-code"
          emptyMessage="No patch available."
          rows={rows}
          renderRow={(row, index) =>
            row.kind === "spacer" ? (
              <div className="workspace-diff-spacer split" key={`${row.label}-${index}`} role="row">
                {row.label}
              </div>
            ) : (
              <div className={`workspace-split-row ${row.kind}`} key={`${row.oldLine}-${row.newLine}-${index}`} role="row">
                <span className="workspace-diff-line-number old" role="cell">
                  {row.oldLine}
                </span>
                <code className="old" role="cell">
                  <SyntaxLine language={language} text={row.oldContent || " "} />
                </code>
                <span className="workspace-diff-line-number new" role="cell">
                  {row.newLine}
                </span>
                <code className="new" role="cell">
                  <SyntaxLine language={language} text={row.newContent || " "} />
                </code>
              </div>
            )
          }
          wordWrap={wordWrap}
        />
      )}
    </div>
  );
}


function DocumentPreview({ file, contentBase64 }: { file: WorkspaceDiffFile; contentBase64: string }) {
  const objectUrl = useMemo(() => {
    const bytes = base64ToUint8Array(contentBase64);
    if (!bytes) return null;
    const blob = new Blob([new Uint8Array(bytes)], { type: documentMimeType(file.path) });
    return URL.createObjectURL(blob);
  }, [contentBase64, file.path]);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  if (!objectUrl) {
    return <div className="workspace-diff-code-empty">Document preview unavailable.</div>;
  }

  return (
    <div className="workspace-document-preview">
      <div className="workspace-document-preview-card">
        <strong>{file.path.split("/").pop()}</strong>
        <span>Word document</span>
        <a href={objectUrl} download={file.path.split("/").pop() || "document"}>
          Download document
        </a>
      </div>
      <iframe src={objectUrl} title={`${file.path} preview`} />
    </div>
  );
}

function documentMimeType(path: string): string {
  return /\.docx$/i.test(path)
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "application/msword";
}

function isLikelyBase64Document(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(value);
}

function base64ToUint8Array(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

type PatchRow =
  | { kind: "spacer"; label: string }
  | PatchCodeRow;

type PatchCodeRow = {
  kind: "context" | "addition" | "deletion";
  oldLine: string;
  newLine: string;
  oldContent: string;
  newContent: string;
};

function VirtualizedDiffRows({
  ariaLabel,
  className,
  emptyMessage,
  rows,
  renderRow,
  wordWrap,
}: {
  ariaLabel: string;
  className: string;
  emptyMessage: string;
  rows: PatchRow[];
  renderRow: (row: PatchRow, index: number) => ReactNode;
  wordWrap: boolean;
}) {
  const virtualized = !wordWrap && rows.length > DIFF_VIRTUALIZE_THRESHOLD;
  const { endIndex, offsetTop, scrollRef, startIndex, totalHeight } = useVirtualDiffRows(rows.length, virtualized);
  if (rows.length === 0) {
    return (
      <div className={className} role="table" aria-label={ariaLabel}>
        <div className="workspace-diff-code-empty">{emptyMessage}</div>
      </div>
    );
  }
  if (!virtualized) {
    return (
      <div className={className} role="table" aria-label={ariaLabel}>
        {rows.map(renderRow)}
      </div>
    );
  }
  return (
    <div
      className={`${className} virtualized`}
      ref={scrollRef}
      role="table"
      aria-label={ariaLabel}
      aria-rowcount={rows.length}
    >
      <div className="workspace-diff-virtual-spacer" style={{ height: totalHeight }}>
        <div className="workspace-diff-virtual-window" style={{ transform: `translateY(${offsetTop}px)` }}>
          {rows.slice(startIndex, endIndex).map((row, index) => renderRow(row, startIndex + index))}
        </div>
      </div>
    </div>
  );
}

function useVirtualDiffRows(rowCount: number, enabled: boolean): {
  endIndex: number;
  offsetTop: number;
  scrollRef: Ref<HTMLDivElement>;
  startIndex: number;
  totalHeight: number;
} {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({
    height: DIFF_ROW_HEIGHT * DIFF_DEFAULT_VIEWPORT_ROWS,
    scrollTop: 0,
  });
  const updateViewport = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setViewport({
      height: element.clientHeight || DIFF_ROW_HEIGHT * DIFF_DEFAULT_VIEWPORT_ROWS,
      scrollTop: element.scrollTop,
    });
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const element = scrollRef.current;
    if (!element) return undefined;
    updateViewport();

    let animationFrame = 0;
    const scheduleUpdate = () => {
      if (typeof window === "undefined") {
        updateViewport();
        return;
      }
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updateViewport);
    };
    element.addEventListener("scroll", scheduleUpdate, { passive: true });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => scheduleUpdate());
    resizeObserver?.observe(element);

    return () => {
      element.removeEventListener("scroll", scheduleUpdate);
      resizeObserver?.disconnect();
      if (typeof window !== "undefined") window.cancelAnimationFrame(animationFrame);
    };
  }, [enabled, updateViewport]);

  if (!enabled) {
    return {
      endIndex: rowCount,
      offsetTop: 0,
      scrollRef,
      startIndex: 0,
      totalHeight: rowCount * DIFF_ROW_HEIGHT,
    };
  }

  const visibleRows = Math.ceil(viewport.height / DIFF_ROW_HEIGHT);
  const startIndex = Math.max(0, Math.floor(viewport.scrollTop / DIFF_ROW_HEIGHT) - DIFF_VIRTUAL_OVERSCAN_ROWS);
  const endIndex = Math.min(rowCount, startIndex + visibleRows + DIFF_VIRTUAL_OVERSCAN_ROWS * 2);
  return {
    endIndex,
    offsetTop: startIndex * DIFF_ROW_HEIGHT,
    scrollRef,
    startIndex,
    totalHeight: rowCount * DIFF_ROW_HEIGHT,
  };
}

function parsePatchRows(patch: string, hideWhiteSpace: boolean): PatchRow[] {
  if (!patch.trim()) return [];
  const rows: PatchRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let previousHunkOldEnd: number | null = null;
  let previousHunkNewEnd: number | null = null;
  let inHunk = false;
  let pendingContextRows: PatchCodeRow[] = [];

  function flushContextRows() {
    rows.push(...foldContextRows(pendingContextRows));
    pendingContextRows = [];
  }

  function finishHunk() {
    if (!inHunk) return;
    flushContextRows();
    previousHunkOldEnd = oldLine;
    previousHunkNewEnd = newLine;
    inHunk = false;
  }

  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      finishHunk();
      const hunkOldStart = Number(hunk[1]);
      const hunkNewStart = Number(hunk[2]);
      if (previousHunkOldEnd !== null && previousHunkNewEnd !== null) {
        const hiddenLines = Math.max(hunkOldStart - previousHunkOldEnd, hunkNewStart - previousHunkNewEnd, 0);
        if (hiddenLines > 0) rows.push({ kind: "spacer", label: formatUnmodifiedLineCount(hiddenLines) });
      }
      oldLine = hunkOldStart;
      newLine = hunkNewStart;
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }
    if (!inHunk || line.startsWith("\\ No newline")) continue;
    const content = line.slice(1) || " ";
    if (hideWhiteSpace && !content.trim()) continue;
    if (line.startsWith("+")) {
      flushContextRows();
      rows.push({ kind: "addition", oldLine: "", newLine: String(newLine || ""), oldContent: "", newContent: content });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      flushContextRows();
      rows.push({ kind: "deletion", oldLine: String(oldLine || ""), newLine: "", oldContent: content, newContent: "" });
      oldLine += 1;
      continue;
    }
    const context = line.startsWith(" ") ? line.slice(1) || " " : line || " ";
    if (hideWhiteSpace && !context.trim()) continue;
    pendingContextRows.push({
      kind: "context",
      oldLine: String(oldLine || ""),
      newLine: String(newLine || ""),
      oldContent: context,
      newContent: context,
    });
    oldLine += 1;
    newLine += 1;
  }
  finishHunk();
  return rows;
}

function foldContextRows(rows: PatchCodeRow[]): PatchRow[] {
  if (rows.length < PATCH_CONTEXT_FOLD_MIN_LINES) return rows;
  const hiddenCount = rows.length - PATCH_CONTEXT_EDGE_LINES * 2;
  if (hiddenCount <= 0) return rows;
  return [
    ...rows.slice(0, PATCH_CONTEXT_EDGE_LINES),
    { kind: "spacer", label: formatUnmodifiedLineCount(hiddenCount) },
    ...rows.slice(-PATCH_CONTEXT_EDGE_LINES),
  ];
}

function formatUnmodifiedLineCount(count: number): string {
  return `${count} unmodified ${count === 1 ? "line" : "lines"}`;
}
