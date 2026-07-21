import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import {
  BookOpenText,
  CircleAlert,
  CircleCheck,
  Columns2,
  FileText,
  FolderOpen,
  Globe2,
  Info,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minimize2,
  MoreHorizontal,
  Plus,
  Redo2,
  Save,
  Search,
  Undo2,
  X,
} from "../icons";
import type { WorkspaceDiffFile } from "@openpond/contracts";
import { DiffOptionsMenu } from "./WorkspaceDiffOptions";
import {
  nextRovingTabIndex,
  type DiffTab,
  type RovingTabKey,
  type WorkspaceDiffSideChatTab,
  type WorkspaceFileSourceSwitcher,
} from "./workspace-diff-panel-model";

export function WorkspaceDiffTabs({
  addMenuOpen,
  expanded,
  filteredFiles,
  dirtyFilePaths,
  openFiles,
  goalDetailsAvailable,
  searchOpen,
  searchQuery,
  selectedPath,
  sideChatTabs = [],
  summaryAvailable,
  sourceStatus,
  sourceSwitcher,
  visibleTab,
  onCloseFileTab,
  onCloseSideChat,
  onCloseSearch,
  onOpenFile,
  onOpenBrowser,
  onOpenSearch,
  onOpenSideChat,
  onSearchQueryChange,
  onSelectFile,
  onSelectFiles,
  onSelectGoal,
  onSelectSummary,
  onSelectSideChat,
  onToggleAddMenu,
  onToggleExpanded,
}: {
  addMenuOpen: boolean;
  expanded: boolean;
  filteredFiles: string[];
  dirtyFilePaths: ReadonlySet<string>;
  openFiles: WorkspaceDiffFile[];
  goalDetailsAvailable: boolean;
  searchOpen: boolean;
  searchQuery: string;
  selectedPath: string | null;
  sideChatTabs?: WorkspaceDiffSideChatTab[];
  summaryAvailable?: boolean;
  sourceStatus?: { label: string; tone: "clean" | "dirty" | "loading" | "error" } | null;
  sourceSwitcher?: WorkspaceFileSourceSwitcher | null;
  visibleTab: DiffTab;
  onCloseFileTab: (path: string, event: MouseEvent<HTMLButtonElement>) => void;
  onCloseSideChat?: (panelId: string) => void;
  onCloseSearch: () => void;
  onOpenFile: (path: string) => void;
  onOpenBrowser: () => void;
  onOpenSearch: () => void;
  onOpenSideChat?: () => void;
  onSearchQueryChange: (value: string) => void;
  onSelectFile: (path: string) => void;
  onSelectFiles: () => void;
  onSelectGoal: () => void;
  onSelectSummary?: () => void;
  onSelectSideChat?: (panelId: string) => void;
  onToggleAddMenu: () => void;
  onToggleExpanded: () => void;
}) {
  const addAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!addMenuOpen && !searchOpen) return undefined;
    function closeOpenControls() {
      if (addMenuOpen) onToggleAddMenu();
      if (searchOpen) onCloseSearch();
    }
    function handlePointerDown(event: PointerEvent) {
      if (addAnchorRef.current?.contains(event.target as Node)) return;
      closeOpenControls();
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") closeOpenControls();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [addMenuOpen, onCloseSearch, onToggleAddMenu, searchOpen]);

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      onCloseSearch();
      return;
    }
    if (event.key === "Enter" && filteredFiles[0]) onOpenFile(filteredFiles[0]);
  }

  function handleTabListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.getAttribute("role") !== "tab") return;
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
    );
    const currentIndex = tabs.indexOf(target);
    if (currentIndex < 0 || tabs.length === 0) return;
    event.preventDefault();
    const nextIndex = nextRovingTabIndex(
      currentIndex,
      tabs.length,
      event.key as RovingTabKey,
    );
    const next = tabs[nextIndex];
    if (!next) return;
    next.focus();
    next.click();
    const nextId = next.id;
    if (nextId) {
      window.requestAnimationFrame(() => document.getElementById(nextId)?.focus());
    }
  }

  return (
    <div className="workspace-diff-topbar">
      <div
        className="workspace-diff-tabs"
        role="tablist"
        aria-label="Right sidebar views"
        onKeyDown={handleTabListKeyDown}
      >
        {goalDetailsAvailable ? (
          <button
            type="button"
            className={`workspace-diff-tab ${visibleTab === "goal" ? "active" : ""}`}
            role="tab"
            aria-selected={visibleTab === "goal"}
            onClick={onSelectGoal}
          >
            <FileText size={14} />
            <span>Goal</span>
          </button>
        ) : null}
        {summaryAvailable && onSelectSummary ? (
          <button
            type="button"
            className={`workspace-diff-tab ${visibleTab === "summary" ? "active" : ""}`}
            role="tab"
            aria-selected={visibleTab === "summary"}
            onClick={onSelectSummary}
          >
            <Info size={14} />
            <span>Summary</span>
          </button>
        ) : null}
        <button
          type="button"
          className={`workspace-diff-tab ${visibleTab === "files" ? "active" : ""}`}
          role="tab"
          id="right-sidebar-files-tab"
          aria-controls="right-sidebar-files-panel"
          aria-selected={visibleTab === "files"}
          tabIndex={visibleTab === "files" ? 0 : -1}
          onClick={onSelectFiles}
        >
          <FolderOpen size={14} />
          <span>Files</span>
        </button>
        {openFiles.map((file) => (
          <div
            className={`workspace-diff-tab file ${visibleTab === "file" && selectedPath === file.path ? "active" : ""}`}
            key={file.path}
          >
            <button
              type="button"
              className="workspace-diff-tab-main"
              role="tab"
              aria-selected={visibleTab === "file" && selectedPath === file.path}
              title={file.path}
              onClick={() => onSelectFile(file.path)}
            >
              <FileText className="workspace-diff-tab-icon" size={13} />
              {dirtyFilePaths.has(file.path) && <span className="workspace-diff-tab-dirty" aria-hidden="true" />}
              <span>{file.path.split("/").pop()}</span>
            </button>
            <button
              type="button"
              className="workspace-diff-tab-close"
              title={`Close ${file.path}`}
              onClick={(event) => onCloseFileTab(file.path, event)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {sideChatTabs.map((chat) => (
          <div className="workspace-diff-tab right-chat-tab" key={chat.id}>
            <button
              type="button"
              className="workspace-diff-tab-main"
              role="tab"
              id={`right-chat-tab-${chat.id}`}
              aria-controls={`right-chat-panel-${chat.id}`}
              aria-selected={false}
              tabIndex={-1}
              title={chat.title}
              onClick={() => onSelectSideChat?.(chat.id)}
            >
              <span>{chat.title}</span>
            </button>
            {onCloseSideChat ? (
              <button
                type="button"
                className="workspace-diff-tab-close"
                title={`Close ${chat.title}`}
                aria-label={`Close ${chat.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseSideChat(chat.id);
                }}
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
        ))}
        <div className="workspace-diff-add-anchor" ref={addAnchorRef}>
          <button
            type="button"
            className={`workspace-diff-add-tab ${addMenuOpen || searchOpen ? "active" : ""}`}
            title="Add"
            aria-label="Add to right sidebar"
            onClick={onToggleAddMenu}
          >
            <Plus size={15} />
          </button>
          {addMenuOpen && (
            <div className="workspace-diff-add-menu" role="menu">
              {onOpenSideChat ? (
                <button type="button" role="menuitem" onClick={onOpenSideChat}>
                  <MessageSquare size={14} />
                  <span>New task</span>
                  <kbd />
                </button>
              ) : null}
              <button type="button" role="menuitem" onClick={onSelectFiles}>
                <FolderOpen size={14} />
                <span>Files</span>
                <kbd />
              </button>
              {summaryAvailable && onSelectSummary ? (
                <button type="button" role="menuitem" onClick={onSelectSummary}>
                  <Info size={14} />
                  <span>Summary</span>
                  <kbd />
                </button>
              ) : null}
              <button type="button" role="menuitem" onClick={onOpenSearch}>
                <Search size={14} />
                <span>Open file</span>
                <kbd>Ctrl+P</kbd>
              </button>
              <button type="button" role="menuitem" onClick={onOpenBrowser}>
                <Globe2 size={14} />
                <span>Browser</span>
                <kbd>Ctrl+I</kbd>
              </button>
            </div>
          )}
          {searchOpen && (
            <div className="workspace-file-search-popover">
              <input
                autoFocus
                placeholder="Search files"
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
              <span>Files</span>
              <div className="workspace-file-search-results">
                {filteredFiles.length === 0 ? (
                  <small>Type to search for files</small>
                ) : (
                  filteredFiles.map((path) => (
                    <button type="button" key={path} onClick={() => onOpenFile(path)}>
                      {path}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {sourceSwitcher || sourceStatus ? (
        <div className="workspace-diff-source-bar" aria-label="Workspace source">
          {sourceSwitcher ? (
            <div className="workspace-diff-source-toggle" role="group" aria-label="File source">
              {sourceSwitcher.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={sourceSwitcher.value === option.value ? "active" : ""}
                  aria-pressed={sourceSwitcher.value === option.value}
                  onClick={() => sourceSwitcher.onChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          {sourceStatus ? (
            <span className={`workspace-diff-source-status ${sourceStatus.tone}`}>
              {sourceStatus.label}
            </span>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="diff-icon-button"
        title={expanded ? "Restore files panel" : "Expand files panel"}
        aria-label={expanded ? "Restore files panel" : "Expand files panel"}
        onClick={onToggleExpanded}
      >
        {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
    </div>
  );
}

export function WorkspaceDiffToolbar({
  canCheckActiveFile,
  canSaveActiveFile,
  collapsed,
  editorControlsVisible,
  editorDiagnosticStatus,
  editorDiagnosticsChecking,
  hideWhiteSpace,
  loadFullFiles,
  menuOpen,
  renderMarkdown,
  showEditorCommandBar,
  showRenderMarkdownToggle,
  splitView,
  wordDiffs,
  wordWrap,
  onCopyGitApply,
  onEditorCheck,
  onEditorRedo,
  onEditorSave,
  onEditorUndo,
  onRefresh,
  onToggleCollapsed,
  onToggleEditorControlsVisible,
  onToggleHideWhiteSpace,
  onToggleLoadFullFiles,
  onToggleMenu,
  onToggleRenderMarkdown,
  onToggleSplitView,
  onToggleWordDiffs,
  onToggleWordWrap,
}: {
  canCheckActiveFile: boolean;
  canSaveActiveFile: boolean;
  collapsed: boolean;
  editorControlsVisible: boolean;
  editorDiagnosticStatus: EditorDiagnosticStatus | null;
  editorDiagnosticsChecking: boolean;
  hideWhiteSpace: boolean;
  loadFullFiles: boolean;
  menuOpen: boolean;
  renderMarkdown: boolean;
  showEditorCommandBar: boolean;
  showRenderMarkdownToggle: boolean;
  splitView: boolean;
  wordDiffs: boolean;
  wordWrap: boolean;
  onCopyGitApply: () => void;
  onEditorCheck: () => void;
  onEditorRedo: () => void;
  onEditorSave: () => void;
  onEditorUndo: () => void;
  onRefresh: () => void;
  onToggleCollapsed: () => void;
  onToggleEditorControlsVisible: () => void;
  onToggleHideWhiteSpace: () => void;
  onToggleLoadFullFiles: () => void;
  onToggleMenu: (open?: boolean) => void;
  onToggleRenderMarkdown: () => void;
  onToggleSplitView: () => void;
  onToggleWordDiffs: () => void;
  onToggleWordWrap: () => void;
}) {
  return (
    <div className="workspace-diff-toolbar">
      <div className="workspace-diff-toolbar-actions">
        <div className="workspace-diff-menu-anchor">
          <button
            type="button"
            className="diff-icon-button"
            title="Diff options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => onToggleMenu()}
          >
            <MoreHorizontal size={15} />
          </button>
          {menuOpen && (
            <DiffOptionsMenu
              collapsed={collapsed}
              editorControlsVisible={editorControlsVisible}
              hideWhiteSpace={hideWhiteSpace}
              loadFullFiles={loadFullFiles}
              renderMarkdown={renderMarkdown}
              wordDiffs={wordDiffs}
              wordWrap={wordWrap}
              onClose={() => onToggleMenu(false)}
              onCopyGitApply={onCopyGitApply}
              onRefresh={onRefresh}
              onToggleCollapsed={onToggleCollapsed}
              onToggleEditorControlsVisible={onToggleEditorControlsVisible}
              onToggleHideWhiteSpace={onToggleHideWhiteSpace}
              onToggleLoadFullFiles={onToggleLoadFullFiles}
              onToggleRenderMarkdown={onToggleRenderMarkdown}
              onToggleWordDiffs={onToggleWordDiffs}
              onToggleWordWrap={onToggleWordWrap}
            />
          )}
        </div>
        {showEditorCommandBar && (
          <div className="workspace-editor-command-bar" aria-label="Editor controls">
            <button
              type="button"
              className="diff-icon-button"
              title="Save file"
              aria-label="Save file"
              disabled={!canSaveActiveFile}
              onClick={onEditorSave}
            >
              <Save size={14} />
            </button>
            <button
              type="button"
              className="diff-icon-button"
              title="Undo"
              aria-label="Undo"
              onClick={onEditorUndo}
            >
              <Undo2 size={14} />
            </button>
            <button
              type="button"
              className="diff-icon-button"
              title="Redo"
              aria-label="Redo"
              onClick={onEditorRedo}
            >
              <Redo2 size={14} />
            </button>
            <button
              type="button"
              className="diff-icon-button"
              title="Check file"
              aria-label="Check file"
              disabled={!canCheckActiveFile}
              onClick={onEditorCheck}
            >
              {editorDiagnosticsChecking ? (
                <LoaderCircle className="spinning" size={14} />
              ) : (
                <CircleCheck size={14} />
              )}
            </button>
            {editorDiagnosticStatus && (
              <span className={`workspace-editor-diagnostic-chip ${editorDiagnosticStatus.severity}`}>
                {editorDiagnosticStatus.severity === "error" ||
                editorDiagnosticStatus.severity === "warning" ||
                editorDiagnosticStatus.severity === "unavailable" ? (
                  <CircleAlert size={13} />
                ) : (
                  <CircleCheck size={13} />
                )}
                <span>{editorDiagnosticStatus.label}</span>
              </span>
            )}
          </div>
        )}
        {showRenderMarkdownToggle && (
          <button
            type="button"
            className={`diff-icon-button ${renderMarkdown ? "active" : ""}`}
            title={renderMarkdown ? "Show Markdown source" : "Render Markdown"}
            aria-label={renderMarkdown ? "Show Markdown source" : "Render Markdown"}
            aria-pressed={renderMarkdown}
            onClick={onToggleRenderMarkdown}
          >
            <BookOpenText size={14} />
          </button>
        )}
        <button
          type="button"
          className={`diff-icon-button ${splitView ? "active" : ""}`}
          title={splitView ? "Show unified diff" : "Show split diff"}
          aria-label={splitView ? "Show unified diff" : "Show split diff"}
          aria-pressed={splitView}
          onClick={onToggleSplitView}
        >
          <Columns2 size={14} />
        </button>
      </div>
    </div>
  );
}

export type EditorDiagnosticStatus = {
  label: string;
  severity: "none" | "error" | "warning" | "info" | "unavailable";
};
