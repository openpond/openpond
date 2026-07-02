import { useState } from "react";
import { ArrowUpRight, ChevronDown } from "../icons";
import type { WorkspaceDiffFile, WorkspaceDiffSummary } from "@openpond/contracts";

export function ChangeSummaryCard({
  summary,
  onOpenFileInSidebar,
}: {
  summary: WorkspaceDiffSummary;
  onOpenFileInSidebar?: (path: string) => void;
}) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const title = `${summary.filesChanged} ${summary.filesChanged === 1 ? "file" : "files"} changed`;
  const totals = summary.files.reduce(
    (counts, file) => {
      const fileCounts = displayFileCounts(file);
      return {
        additions: counts.additions + fileCounts.additions,
        deletions: counts.deletions + fileCounts.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );
  return (
    <div className="change-summary-card">
      <div className="change-summary-header">
        <span>{title}</span>
        <span className="change-summary-counts">
          <span className="diff-addition">+{totals.additions}</span>
          <span className="diff-deletion">-{totals.deletions}</span>
        </span>
      </div>
      <div className="change-summary-files">
        {summary.files.map((file) => (
          <ChangeSummaryFile
            file={file}
            key={file.path}
            onOpenFileInSidebar={onOpenFileInSidebar}
            open={openPath === file.path}
            onToggle={() => setOpenPath((current) => (current === file.path ? null : file.path))}
          />
        ))}
      </div>
    </div>
  );
}

function ChangeSummaryFile({
  file,
  onOpenFileInSidebar,
  open,
  onToggle,
}: {
  file: WorkspaceDiffFile;
  onOpenFileInSidebar?: (path: string) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const counts = displayFileCounts(file);
  const patchUnavailable = isAccessErrorPatch(file.patch);
  return (
    <div className="change-summary-file">
      <div className="change-summary-file-trigger">
        <button type="button" className="change-summary-file-toggle" onClick={onToggle}>
          <span>{file.path}</span>
        </button>
        <span className="change-summary-counts">
          <span className="diff-addition">+{counts.additions}</span>
          <span className="diff-deletion">-{counts.deletions}</span>
        </span>
        {onOpenFileInSidebar && (
          <button
            type="button"
            className="change-summary-open-file"
            title="Open in sidebar"
            aria-label={`Open ${file.path} in sidebar`}
            onClick={() => onOpenFileInSidebar(file.path)}
          >
            <ArrowUpRight size={14} />
          </button>
        )}
        <button
          type="button"
          className="change-summary-expand-file"
          title={open ? "Hide patch" : "Show patch"}
          aria-label={open ? `Hide ${file.path} patch` : `Show ${file.path} patch`}
          onClick={onToggle}
        >
          <ChevronDown className={open ? "expanded" : ""} size={14} />
        </button>
      </div>
      {open && patchUnavailable && (
        <div className="change-summary-patch-unavailable">Patch is no longer available for this workspace path.</div>
      )}
      {open && file.patch && !patchUnavailable && (
        <pre className="change-summary-patch">
          <code>{file.patch}</code>
        </pre>
      )}
    </div>
  );
}

function displayFileCounts(file: WorkspaceDiffFile): { additions: number; deletions: number } {
  if ((file.status === "added" || file.status === "untracked") && file.additions === 0 && file.content) {
    return { additions: countTextLines(file.content), deletions: 0 };
  }
  if ((file.additions > 0 || file.deletions > 0) || !file.patch || isAccessErrorPatch(file.patch)) {
    return { additions: file.additions, deletions: file.deletions };
  }
  const patchCounts = countPatchChanges(file.patch);
  if (patchCounts.additions > 0 || patchCounts.deletions > 0) return patchCounts;
  return { additions: file.additions, deletions: file.deletions };
}

function countTextLines(content: string): number {
  const withoutTrailingNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  return withoutTrailingNewline ? withoutTrailingNewline.split("\n").length : 0;
}

function isAccessErrorPatch(patch: string): boolean {
  return /^error: Could not access /m.test(patch);
}

function countPatchChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}
