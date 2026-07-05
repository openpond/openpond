import type { ReactNode } from "react";
import { AlignLeft, ArrowRight, BookOpenText, Check, ChevronsUp, Clipboard, EyeOff, FileText, PanelTop, RefreshCw } from "../icons";

export function DiffOptionsMenu({
  collapsed,
  editorControlsVisible,
  hideWhiteSpace,
  loadFullFiles,
  renderMarkdown,
  wordDiffs,
  wordWrap,
  onClose,
  onCopyGitApply,
  onRefresh,
  onToggleCollapsed,
  onToggleEditorControlsVisible,
  onToggleHideWhiteSpace,
  onToggleLoadFullFiles,
  onToggleRenderMarkdown,
  onToggleWordDiffs,
  onToggleWordWrap,
}: {
  collapsed: boolean;
  editorControlsVisible: boolean;
  hideWhiteSpace: boolean;
  loadFullFiles: boolean;
  renderMarkdown: boolean;
  wordDiffs: boolean;
  wordWrap: boolean;
  onClose: () => void;
  onCopyGitApply: () => void;
  onRefresh: () => void;
  onToggleCollapsed: () => void;
  onToggleEditorControlsVisible: () => void;
  onToggleHideWhiteSpace: () => void;
  onToggleLoadFullFiles: () => void;
  onToggleRenderMarkdown: () => void;
  onToggleWordDiffs: () => void;
  onToggleWordWrap: () => void;
}) {
  return (
    <div className="workspace-diff-options-menu" role="menu">
      <DiffOption icon={<RefreshCw size={14} />} label="Refresh" onClick={onRefresh} onClose={onClose} />
      <DiffOption checked={wordWrap} icon={<ArrowRight size={14} />} label="Enable word wrap" onClick={onToggleWordWrap} onClose={onClose} />
      <DiffOption checked={collapsed} icon={<ChevronsUp size={14} />} label="Collapse all diffs" onClick={onToggleCollapsed} onClose={onClose} />
      <div className="workspace-diff-menu-divider" />
      <DiffOption checked={editorControlsVisible} icon={<PanelTop size={14} />} label="Show editor controls" onClick={onToggleEditorControlsVisible} onClose={onClose} />
      <DiffOption checked={renderMarkdown} icon={<BookOpenText size={14} />} label="Render Markdown" onClick={onToggleRenderMarkdown} onClose={onClose} />
      <DiffOption checked={!loadFullFiles} icon={<FileText size={14} />} label="Show diffs first" onClick={onToggleLoadFullFiles} onClose={onClose} />
      <DiffOption checked={wordDiffs} icon={<AlignLeft size={14} />} label="Enable word diffs" onClick={onToggleWordDiffs} onClose={onClose} />
      <DiffOption checked={hideWhiteSpace} icon={<EyeOff size={14} />} label="Hide white space" onClick={onToggleHideWhiteSpace} onClose={onClose} />
      <DiffOption icon={<Clipboard size={14} />} label="Copy git apply command" onClick={onCopyGitApply} onClose={onClose} />
    </div>
  );
}

function DiffOption({
  checked,
  icon,
  label,
  onClick,
  onClose,
}: {
  checked?: boolean;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onClick?.();
        onClose();
      }}
    >
      {icon}
      <span>{label}</span>
      {checked && <Check size={14} />}
    </button>
  );
}
