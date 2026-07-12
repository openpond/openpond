import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { RuntimeEvent, SubagentLifecycleAction, WorkspaceDiffFile, WorkspaceDiffSummary, WorkspaceEditorPreferences, WorkspaceKind, WorkspaceLspActionResponse, WorkspaceLspDiagnostic, WorkspaceLspServerStatus } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { useWorkspaceImageUrl } from "../../hooks/useWorkspaceImageUrl";
import { DEFAULT_APP_PREFERENCES } from "../../lib/app-models";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import { isWorkspaceImagePath } from "../../lib/workspace-images";
import { ImageLightbox } from "../common/ImageLightbox";
import { GoalDetailsView, type GoalDetailsCreateRuntime } from "../goal/GoalDetailsView";
import { SandboxWorkspaceSummary } from "./SandboxWorkspaceSummary";
import { WorkspaceDiffFiles } from "./WorkspaceDiffFiles";
import { WorkspaceDiffTabs, WorkspaceDiffToolbar } from "./WorkspaceDiffPanelChrome";
import { FilePreview } from "./WorkspaceFilePreview";
import { FILE_TRUNCATED_MARKER, readSandboxFile, sandboxChangedFiles, sandboxRepoFiles, sandboxSourceReadbackDiffFromEvents, saveSandboxFile } from "./workspace-diff-file-model";
import type { WorkspaceMonacoEditorHandle, WorkspaceMonacoLspActionInput } from "./WorkspaceMonacoEditor";
import {
  WORKSPACE_TEMPLATE_CONFIG_PATH,
  cloneWorkspaceDiffPanelViewState,
  defaultWorkspaceDiffPanelViewState,
  isDirectoryLikeDiffFile,
  isMarkdownPath,
  normalizeWorkspaceDiffPanelViewState,
  normalizeWorkspaceDiffPath,
  placeholderFile,
  workspaceDiffPanelViewStatesEqual,
  type DiffTab,
  type FileDraft,
  type SandboxFileSource,
  type WorkspaceDiffPanelViewState,
  type WorkspaceDiffRefreshOptions,
  type WorkspaceDiffSideChatTab,
  type WorkspaceDiffTabRequest,
  type WorkspaceFileSourceSwitcher,
} from "./workspace-diff-panel-model";
import { editorDiagnosticStatus as resolveEditorDiagnosticStatus, readEditorControlsVisible, writeEditorControlsVisible } from "./workspace-diff-editor-state";

const WORKSPACE_DIFF_REFRESH_INTERVAL_MS = 3_000;
const SANDBOX_FILE_TREE_MAX_ENTRIES = 2_000;
const EMPTY_WORKSPACE_DIFF_FILES: WorkspaceDiffFile[] = [];
const EMPTY_REPO_FILES: string[] = [];

export function WorkspaceDiffPanel({
  appId,
  workspaceKind,
  connection,
  runtimeEvents,
  diff,
  editorPreferences,
  loading,
  workspaceName,
  workspaceInitialized,
  workspaceError,
  expanded,
  fileRootPath,
  openFileRequest,
  sideChatTabs,
  sourceSwitcher,
  tabRequest,
  viewState,
  onRefresh,
  onResizeStart,
  onToggleExpanded,
  onOpenBrowser,
  onViewStateChange,
  onCloseSideChat,
  onOpenSideChat,
  onSelectSideChat,
  goalDetails,
  sandboxFileSource,
}: {
  appId: string | null;
  workspaceId: string | null;
  workspaceKind: WorkspaceKind | null;
  connection: ClientConnection | null;
  runtimeEvents?: RuntimeEvent[];
  diff: WorkspaceDiffSummary | null;
  editorPreferences?: WorkspaceEditorPreferences | null;
  loading: boolean;
  workspaceName: string | null;
  workspaceInitialized: boolean;
  workspaceError: string | null;
  expanded: boolean;
  fileRootPath?: string | null;
  openFileRequest?: { id: number; path: string } | null;
  sideChatTabs?: WorkspaceDiffSideChatTab[];
  sourceSwitcher?: WorkspaceFileSourceSwitcher | null;
  tabRequest?: WorkspaceDiffTabRequest | null;
  viewState?: WorkspaceDiffPanelViewState | null;
  onRefresh: (options?: WorkspaceDiffRefreshOptions) => Promise<void> | void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleExpanded: () => void;
  onOpenBrowser: () => void;
  onOpenBrowserUrl: (href: string, options?: { newTab?: boolean }) => void;
  onViewStateChange?: (state: WorkspaceDiffPanelViewState) => void;
  onCloseSideChat?: (panelId: string) => void;
  onOpenSideChat?: () => void;
  onSelectSideChat?: (panelId: string) => void;
  goalDetails?: WorkspaceGoalDetails | null;
  sandboxFileSource?: SandboxFileSource | null;
}) {
  return (
    <WorkspaceDiffPanelInner
      appId={appId}
      workspaceKind={workspaceKind}
      connection={connection}
      runtimeEvents={runtimeEvents ?? []}
      diff={diff}
      editorPreferences={editorPreferences ?? null}
      loading={loading}
      workspaceName={workspaceName}
      workspaceInitialized={workspaceInitialized}
      workspaceError={workspaceError}
      expanded={expanded}
      fileRootPath={fileRootPath ?? null}
      openFileRequest={openFileRequest}
      sideChatTabs={sideChatTabs ?? []}
      sourceSwitcher={sourceSwitcher ?? null}
      tabRequest={tabRequest ?? null}
      viewState={viewState ?? null}
      onRefresh={onRefresh}
      onResizeStart={onResizeStart}
      onToggleExpanded={onToggleExpanded}
      onOpenBrowser={onOpenBrowser}
      onViewStateChange={onViewStateChange}
      onCloseSideChat={onCloseSideChat}
      onOpenSideChat={onOpenSideChat}
      onSelectSideChat={onSelectSideChat}
      goalDetails={goalDetails ?? null}
      sandboxFileSource={sandboxFileSource ?? null}
    />
  );
}

type WorkspaceGoalDetails = {
  active: boolean;
  createRuntime: GoalDetailsCreateRuntime | null;
  goalRuntime: GoalRuntimeStatus | null;
  subagentRuntime: SubagentRuntimeStatus | null;
};

function detailedWorkspaceFile(
  current: WorkspaceDiffFile | undefined,
  loaded: WorkspaceDiffFile | undefined,
  displayed: WorkspaceDiffFile | undefined,
  path: string,
): WorkspaceDiffFile {
  if (current && loaded?.content != null) {
    return { ...current, content: loaded.content };
  }
  if (loaded && !current && hasWorkspaceFileDetail(loaded)) return loaded;
  if (current && hasWorkspaceFileDetail(current)) return current;
  if (loaded && hasWorkspaceFileDetail(loaded)) return loaded;
  return current ?? loaded ?? displayed ?? placeholderFile(path);
}

function hasWorkspaceFileDetail(file: WorkspaceDiffFile): boolean {
  return Boolean(file.patch || file.content != null);
}

function sourceStatusForDiff({
  changedFiles,
  checkpointStatus,
  dirty,
  error,
  loading,
  preservedReadback,
  sandboxMode,
  sourcePending,
}: {
  changedFiles: number;
  checkpointStatus: { label: string; tone: "clean" | "dirty" | "loading" | "error" } | null;
  dirty: boolean;
  error: string | null;
  loading: boolean;
  preservedReadback: boolean;
  sandboxMode: boolean;
  sourcePending: boolean;
}): { label: string; tone: "clean" | "dirty" | "loading" | "error" } | null {
  if (sourcePending) return { label: "sandbox pending", tone: "loading" };
  if (loading) return { label: "refreshing", tone: "loading" };
  if (sandboxMode && preservedReadback && checkpointStatus) return checkpointStatus;
  if (error) return { label: "status unavailable", tone: "error" };
  if (sandboxMode && checkpointStatus?.tone === "error") return checkpointStatus;
  if (sandboxMode && checkpointStatus && !dirty && changedFiles === 0) return checkpointStatus;
  if (dirty || changedFiles > 0) {
    const count = Math.max(1, changedFiles);
    const noun = count === 1 ? "change" : "changes";
    return {
      label: sandboxMode ? `${count} unpreserved ${noun}` : `${count} local ${noun}`,
      tone: "dirty",
    };
  }
  return { label: sandboxMode ? "sandbox clean" : "local clean", tone: "clean" };
}

function latestSandboxCheckpointStatus(
  runtimeEvents: RuntimeEvent[],
  sandboxId: string | null,
): { label: string; tone: "clean" | "dirty" | "loading" | "error" } | null {
  if (!sandboxId) return null;
  for (let index = runtimeEvents.length - 1; index >= 0; index -= 1) {
    const item = runtimeEvents[index];
    if (item?.name !== "workspace_action_result") continue;
    const data = item.data && typeof item.data === "object" && !Array.isArray(item.data)
      ? item.data as Record<string, unknown>
      : null;
    const preservation = data?.sourcePreservation && typeof data.sourcePreservation === "object" && !Array.isArray(data.sourcePreservation)
      ? data.sourcePreservation as Record<string, unknown>
      : null;
    if (preservation?.attempted !== true) continue;
    if (preservation.sandboxId !== sandboxId) continue;
    if (preservation.ok !== true) return { label: "checkpoint failed", tone: "error" };
    if (preservation.preserved === true) return { label: "checkpoint saved", tone: "clean" };
    return { label: "checkpoint clean", tone: "clean" };
  }
  return null;
}

function folderPathAncestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function WorkspaceDiffPanelInner({
  appId,
  workspaceKind,
  connection,
  runtimeEvents,
  diff,
  editorPreferences,
  loading,
  workspaceName,
  workspaceInitialized,
  workspaceError,
  expanded,
  fileRootPath,
  openFileRequest,
  sideChatTabs,
  sourceSwitcher,
  tabRequest,
  viewState,
  onRefresh,
  onResizeStart,
  onToggleExpanded,
  onOpenBrowser,
  onViewStateChange,
  onCloseSideChat,
  onOpenSideChat,
  onSelectSideChat,
  goalDetails,
  sandboxFileSource,
}: {
  appId: string | null;
  workspaceKind: WorkspaceKind | null;
  connection: ClientConnection | null;
  runtimeEvents: RuntimeEvent[];
  diff: WorkspaceDiffSummary | null;
  editorPreferences: WorkspaceEditorPreferences | null;
  loading: boolean;
  workspaceName: string | null;
  workspaceInitialized: boolean;
  workspaceError: string | null;
  expanded: boolean;
  fileRootPath: string | null;
  openFileRequest?: { id: number; path: string } | null;
  sideChatTabs: WorkspaceDiffSideChatTab[];
  sourceSwitcher: WorkspaceFileSourceSwitcher | null;
  tabRequest: WorkspaceDiffTabRequest | null;
  viewState: WorkspaceDiffPanelViewState | null;
  onRefresh: (options?: WorkspaceDiffRefreshOptions) => Promise<void> | void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleExpanded: () => void;
  onOpenBrowser: () => void;
  onViewStateChange?: (state: WorkspaceDiffPanelViewState) => void;
  onCloseSideChat?: (panelId: string) => void;
  onOpenSideChat?: () => void;
  onSelectSideChat?: (panelId: string) => void;
  goalDetails: WorkspaceGoalDetails | null;
  sandboxFileSource: SandboxFileSource | null;
}) {
  const initialViewState = viewState ?? defaultWorkspaceDiffPanelViewState();
  const [activeTab, setActiveTab] = useState<DiffTab>(initialViewState.activeTab);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [openFilePaths, setOpenFilePaths] = useState<string[]>(() => [...initialViewState.openFilePaths]);
  const [selectedPath, setSelectedPath] = useState<string | null>(initialViewState.selectedPath);
  const [wordWrap, setWordWrap] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [loadFullFiles, setLoadFullFiles] = useState(false);
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [editorControlsVisible, setEditorControlsVisible] = useState(readEditorControlsVisible);
  const [wordDiffs, setWordDiffs] = useState(false);
  const [hideWhiteSpace, setHideWhiteSpace] = useState(false);
  const [splitView, setSplitView] = useState(false);
  const [loadedFiles, setLoadedFiles] = useState<Record<string, WorkspaceDiffFile>>({});
  const [fileDrafts, setFileDrafts] = useState<Record<string, FileDraft>>({});
  const [expandedFileTreeFolders, setExpandedFileTreeFolders] = useState<Set<string>>(() => new Set());
  const [sandboxDiff, setSandboxDiff] = useState<WorkspaceDiffSummary | null>(null);
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const [lspDiagnosticsByPath, setLspDiagnosticsByPath] = useState<Record<string, WorkspaceLspDiagnostic[]>>({});
  const [lspServersByPath, setLspServersByPath] = useState<Record<string, WorkspaceLspServerStatus[]>>({});
  const [lspCheckingPath, setLspCheckingPath] = useState<string | null>(null);
  const [fileLoadingPath, setFileLoadingPath] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileReloadRequest, setFileReloadRequest] = useState<{ id: number; path: string } | null>(null);
  const [fileSaveErrors, setFileSaveErrors] = useState<Record<string, string>>({});
  const [savingPath, setSavingPath] = useState<string | null>(null);
  const [previewImagePath, setPreviewImagePath] = useState<string | null>(null);
  const [templateConfigPath, setTemplateConfigPath] = useState<string | null>(null);
  const activeEditorPreferences = editorPreferences ?? DEFAULT_APP_PREFERENCES.editor;
  const loadedFilesRef = useRef(loadedFiles);
  const appliedViewStateRef = useRef<WorkspaceDiffPanelViewState>(cloneWorkspaceDiffPanelViewState(initialViewState));
  const reportedViewStateRef = useRef<WorkspaceDiffPanelViewState>(cloneWorkspaceDiffPanelViewState(initialViewState));
  const lastOpenFileRequestIdRef = useRef<number | null>(null);
  const refreshRef = useRef(onRefresh);
  const refreshBusyRef = useRef(false);
  const savingPathRef = useRef<string | null>(null);
  const lspRequestSeqRef = useRef(0);
  const lspAbortControllerRef = useRef<AbortController | null>(null);
  const editorHandleRef = useRef<WorkspaceMonacoEditorHandle | null>(null);
  const sandboxId = sandboxFileSource?.sandboxId?.trim() || null;
  const sandboxMode = Boolean(sandboxFileSource);
  const summaryAvailable = sandboxMode && Boolean(sandboxId);
  const sourceKey = sandboxMode ? `sandbox:${sandboxId ?? "pending"}` : `workspace:${appId ?? "none"}`;
  const canOpenRequestedFile = sandboxMode ? Boolean(sandboxId) : Boolean(appId);
  const previousSourceKeyRef = useRef(sourceKey);
  const hasGoalDetails = Boolean(goalDetails?.createRuntime || goalDetails?.goalRuntime || goalDetails?.subagentRuntime);

  const refreshSandboxWorkspace = useCallback(
    async (options: WorkspaceDiffRefreshOptions = {}) => {
      if (!sandboxMode) return;
      if (!connection) {
        setSandboxDiff(null);
        setSandboxError("OpenPond App server is not connected.");
        return;
      }
      if (!sandboxId) {
        setSandboxDiff(null);
        setSandboxError(null);
        return;
      }

      if (!options.silent) setSandboxLoading(true);
      try {
        const [filesResult, statusResult, diffResult] = await Promise.allSettled([
          api.sandboxFiles(connection, sandboxId, { recursive: true, maxEntries: SANDBOX_FILE_TREE_MAX_ENTRIES }),
          api.sandboxGitStatus(connection, sandboxId),
          api.sandboxGitDiff(connection, sandboxId, {}),
        ]);

        if (filesResult.status === "rejected") throw filesResult.reason;

        const repoFiles = sandboxRepoFiles(filesResult.value.files);
        const gitStatus = statusResult.status === "fulfilled" ? statusResult.value.status : null;
        const gitDiff = diffResult.status === "fulfilled" ? diffResult.value.diff : null;
        const files = sandboxChangedFiles(gitDiff, gitStatus);
        const additions = files.reduce((sum, file) => sum + file.additions, 0);
        const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

        setSandboxDiff({
          appId: sandboxId,
          repoPath: "",
          initialized: true,
          dirty: gitStatus ? !gitStatus.clean : files.length > 0,
          filesChanged: files.length,
          additions,
          deletions,
          repoFiles,
          files,
          error: null,
          updatedAt: new Date().toISOString(),
        });
        setSandboxError(null);
      } catch (error) {
        setSandboxDiff(null);
        setSandboxError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!options.silent) setSandboxLoading(false);
      }
    },
    [connection, sandboxId, sandboxMode],
  );

  const sandboxSourceReadbackDiff = useMemo(
    () => sandboxSourceReadbackDiffFromEvents(runtimeEvents, sandboxId),
    [runtimeEvents, sandboxId],
  );
  const sandboxDiffHasInspectableFiles = Boolean(
    sandboxDiff && ((sandboxDiff.files?.length ?? 0) > 0 || (sandboxDiff.repoFiles?.length ?? 0) > 0),
  );
  const usingSandboxSourceReadback = sandboxMode && !sandboxDiffHasInspectableFiles && Boolean(sandboxSourceReadbackDiff);
  const displayDiff = sandboxMode
    ? sandboxDiffHasInspectableFiles
      ? sandboxDiff
      : sandboxSourceReadbackDiff ?? sandboxDiff
    : diff;
  const workspaceRootPath = displayDiff?.repoPath ?? null;
  const checkpointStatus = useMemo(
    () => latestSandboxCheckpointStatus(runtimeEvents, sandboxId),
    [runtimeEvents, sandboxId],
  );
  const rawFiles = displayDiff?.files ?? EMPTY_WORKSPACE_DIFF_FILES;
  const currentDiffFiles = displayDiff?.files ?? EMPTY_WORKSPACE_DIFF_FILES;
  const currentDiffFileByPath = useMemo(
    () => new Map(currentDiffFiles.map((file) => [file.path, file])),
    [currentDiffFiles]
  );
  const displayDiffFileByPath = useMemo(
    () => new Map(rawFiles.map((file) => [file.path, file])),
    [rawFiles]
  );
  const baseRepoFiles: string[] = displayDiff?.repoFiles ?? (rawFiles.length > 0
    ? rawFiles.map((file) => file.path)
    : EMPTY_REPO_FILES);
  const files = useMemo(
    () => rawFiles.filter((file) => !isDirectoryLikeDiffFile(file, baseRepoFiles)),
    [baseRepoFiles, rawFiles]
  );
  const repoFiles = useMemo(
    () =>
      templateConfigPath && !baseRepoFiles.includes(templateConfigPath)
        ? [templateConfigPath, ...baseRepoFiles]
        : baseRepoFiles,
    [baseRepoFiles, templateConfigPath]
  );
  const openFiles = useMemo(
    () =>
      openFilePaths
        .map(
          (path) =>
            currentDiffFileByPath.get(path) ??
            loadedFiles[path] ??
            displayDiffFileByPath.get(path) ??
            placeholderFile(path),
        ),
    [currentDiffFileByPath, displayDiffFileByPath, loadedFiles, openFilePaths]
  );
  const openFileContentByPath = useMemo(() => {
    const next: Record<string, string> = {};
    for (const path of openFilePaths) {
      if (isWorkspaceImagePath(path)) continue;
      const file =
        currentDiffFileByPath.get(path) ??
        loadedFiles[path] ??
        displayDiffFileByPath.get(path) ??
        placeholderFile(path);
      if (file.content != null) next[path] = file.content;
    }
    return next;
  }, [currentDiffFileByPath, displayDiffFileByPath, loadedFiles, openFilePaths]);
  const dirtyFilePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const [path, draft] of Object.entries(fileDrafts)) {
      if (draft.content !== draft.savedContent) paths.add(path);
    }
    return paths;
  }, [fileDrafts]);
  const filteredFiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const paths = repoFiles;
    if (!query) return paths;
    return paths.filter((path) => path.toLowerCase().includes(query));
  }, [repoFiles, searchQuery]);
  const currentViewState = useMemo<WorkspaceDiffPanelViewState>(
    () => ({
      activeTab,
      openFilePaths,
      selectedPath,
    }),
    [activeTab, openFilePaths, selectedPath],
  );

  useEffect(() => {
    loadedFilesRef.current = loadedFiles;
  }, [loadedFiles]);

  useEffect(() => {
    savingPathRef.current = savingPath;
  }, [savingPath]);

  useEffect(() => {
    setFileDrafts((current) => {
      let changed = false;
      const next = { ...current };
      const openPaths = new Set(openFilePaths);
      const diffUpdatedAt = diff?.updatedAt ? Date.parse(diff.updatedAt) : null;

      for (const [path, draft] of Object.entries(next)) {
        if (openPaths.has(path) || draft.content !== draft.savedContent) continue;
        delete next[path];
        changed = true;
      }

      for (const [path, content] of Object.entries(openFileContentByPath)) {
        const draft = next[path];
        if (!draft) {
          next[path] = { content, savedContent: content };
          changed = true;
          continue;
        }
        if (draft.content === draft.savedContent && draft.savedContent !== content) {
          if (draft.savedAt && (diffUpdatedAt === null || diffUpdatedAt < draft.savedAt)) continue;
          next[path] = { content, savedContent: content };
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [diff?.updatedAt, openFileContentByPath, openFilePaths]);

  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (!viewState) return;
    const next = normalizeWorkspaceDiffPanelViewState(viewState, workspaceRootPath);
    if (workspaceDiffPanelViewStatesEqual(appliedViewStateRef.current, next)) return;
    appliedViewStateRef.current = next;
    reportedViewStateRef.current = next;
    setActiveTab(next.activeTab);
    setOpenFilePaths(next.openFilePaths);
    setSelectedPath(next.selectedPath);
  }, [viewState, workspaceRootPath]);

  useEffect(() => {
    if (workspaceDiffPanelViewStatesEqual(reportedViewStateRef.current, currentViewState)) return;
    const next = cloneWorkspaceDiffPanelViewState(currentViewState);
    reportedViewStateRef.current = next;
    appliedViewStateRef.current = next;
    onViewStateChange?.(next);
  }, [currentViewState, onViewStateChange]);

  useEffect(() => {
    if (sandboxMode || !connection || !appId || !workspaceInitialized || diff || workspaceError) return;
    if (refreshBusyRef.current) return;

    refreshBusyRef.current = true;
    void Promise.resolve(refreshRef.current({ silent: true }))
      .catch(() => {
        // refreshWorkspaceDiff already surfaces errors in the app error state.
      })
      .finally(() => {
        refreshBusyRef.current = false;
      });
  }, [appId, connection, diff, sandboxMode, workspaceError, workspaceInitialized]);

  useEffect(() => {
    if (previousSourceKeyRef.current !== sourceKey) {
      previousSourceKeyRef.current = sourceKey;
      lspAbortControllerRef.current?.abort(new Error("lsp_diagnostics_source_changed"));
      lspAbortControllerRef.current = null;
      setOpenFilePaths([]);
      setSelectedPath(null);
      setLoadedFiles({});
      setFileDrafts({});
      setExpandedFileTreeFolders(new Set());
      setSandboxDiff(null);
      setSandboxError(null);
      setSandboxLoading(false);
      setLspDiagnosticsByPath({});
      setLspServersByPath({});
      setLspCheckingPath(null);
      setFileLoadingPath(null);
      setFileError(null);
      setFileReloadRequest(null);
      setFileSaveErrors({});
      setSavingPath(null);
      setPreviewImagePath(null);
      setTemplateConfigPath(null);
    }
    return () => {
      lspAbortControllerRef.current?.abort(new Error("lsp_diagnostics_unmounted"));
      lspAbortControllerRef.current = null;
    };
  }, [sourceKey]);

  useEffect(() => {
    if (!openFileRequest || lastOpenFileRequestIdRef.current === openFileRequest.id) return;
    if (!canOpenRequestedFile) return;
    lastOpenFileRequestIdRef.current = openFileRequest.id;
    openFile(openFileRequest.path);
  }, [canOpenRequestedFile, openFileRequest]);

  useEffect(() => {
    if (!sandboxMode) return undefined;
    void refreshSandboxWorkspace();
    if (!connection || !sandboxId) return undefined;

    let disposed = false;
    async function refresh() {
      if (disposed || refreshBusyRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      refreshBusyRef.current = true;
      try {
        await refreshSandboxWorkspace({ silent: true });
      } finally {
        refreshBusyRef.current = false;
      }
    }

    const intervalId = window.setInterval(() => {
      void refresh();
    }, WORKSPACE_DIFF_REFRESH_INTERVAL_MS);
    const refreshOnFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", refreshOnFocus);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [connection, refreshSandboxWorkspace, sandboxId, sandboxMode]);

  useEffect(() => {
    if (sandboxMode || !connection || !appId || !workspaceInitialized) return undefined;

    let disposed = false;
    async function refresh() {
      if (disposed || refreshBusyRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      refreshBusyRef.current = true;
      try {
        await refreshRef.current({ silent: true });
      } catch {
        // refreshWorkspaceDiff already surfaces errors in the app error state.
      } finally {
        refreshBusyRef.current = false;
      }
    }

    const intervalId = window.setInterval(() => {
      void refresh();
    }, WORKSPACE_DIFF_REFRESH_INTERVAL_MS);
    const refreshOnFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", refreshOnFocus);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [appId, connection, sandboxMode, workspaceInitialized]);

  useEffect(() => {
    if (sandboxMode || !connection || !appId || workspaceKind === "local_project") {
      setTemplateConfigPath(null);
      return undefined;
    }
    let cancelled = false;
    api
      .workspaceTemplateConfig(connection, appId)
      .then((config) => {
        if (!cancelled) setTemplateConfigPath(config.exists ? config.configPath ?? WORKSPACE_TEMPLATE_CONFIG_PATH : null);
      })
      .catch(() => {
        if (!cancelled) setTemplateConfigPath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [appId, connection, sandboxMode, workspaceKind]);

  useEffect(() => {
    if (!selectedPath || repoFiles.includes(selectedPath) || openFilePaths.includes(selectedPath)) return;
    setSelectedPath(files[0]?.path ?? null);
  }, [files, openFilePaths, repoFiles, selectedPath]);

  useEffect(() => {
    if (goalDetails?.active && hasGoalDetails) setActiveTab("goal");
  }, [goalDetails?.active, hasGoalDetails]);

  useEffect(() => {
    if (!tabRequest) return;
    setActiveTab(tabRequest.tab);
  }, [tabRequest]);

  useEffect(() => {
    if (!hasGoalDetails && activeTab === "goal") setActiveTab("files");
  }, [activeTab, hasGoalDetails]);

  useEffect(() => {
    if (!summaryAvailable && activeTab === "summary") setActiveTab("files");
  }, [activeTab, summaryAvailable]);

  const selectedDetailPath = activeTab === "file" ? selectedPath : null;

  useEffect(() => {
    if (!connection || !selectedDetailPath) return undefined;
    if (isWorkspaceImagePath(selectedDetailPath)) {
      setFileError(null);
      setFileLoadingPath((current) => (current === selectedDetailPath ? null : current));
      return undefined;
    }
    const forceReload = fileReloadRequest?.path === selectedDetailPath;
    const diffFile = fileForPath(selectedDetailPath);
    if (!forceReload && (diffFile?.content != null || (diffFile?.patch && !loadFullFiles))) {
      setFileError(null);
      setFileLoadingPath((current) => (current === selectedDetailPath ? null : current));
      return undefined;
    }

    let cancelled = false;
    const loadedFile = loadedFilesRef.current[selectedDetailPath];
    if (loadedFile?.content == null && (loadFullFiles || !loadedFile?.patch)) setFileLoadingPath(selectedDetailPath);
    setFileError(null);
    const request = sandboxMode
      ? sandboxId
        ? readSandboxFile(connection, sandboxId, selectedDetailPath, runtimeEvents)
        : Promise.reject(new Error(sandboxFileSource?.emptyMessage ?? "No sandbox filesystem is available."))
      : appId
        ? api.workspaceFile(connection, appId, selectedDetailPath)
        : Promise.reject(new Error("Workspace files are unavailable."));
    request
      .then((file) => {
        if (cancelled) return;
        setLoadedFiles((current) => {
          const currentFile = current[file.path];
          if (
            currentFile?.content === file.content &&
            currentFile.patch === file.patch &&
            currentFile.status === file.status
          ) {
            return current;
          }
          return { ...current, [file.path]: file };
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setFileError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setFileLoadingPath((current) => (current === selectedDetailPath ? null : current));
          setFileReloadRequest((current) =>
            current && current.id === fileReloadRequest?.id && current.path === selectedDetailPath ? null : current,
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    appId,
    connection,
    fileReloadRequest,
    loadFullFiles,
    runtimeEvents,
    sandboxFileSource?.emptyMessage,
    sandboxId,
    sandboxMode,
    selectedDetailPath,
  ]);

  function openFile(path: string) {
    const normalizedPath = normalizeWorkspaceDiffPath(path, workspaceRootPath);
    if (!normalizedPath) return;
    setLoadedFiles((current) => {
      if (!(normalizedPath in current)) return current;
      const next = { ...current };
      delete next[normalizedPath];
      return next;
    });
    setFileReloadRequest({ id: Date.now(), path: normalizedPath });
    setOpenFilePaths((current) => (current.includes(normalizedPath) ? current : [...current, normalizedPath]));
    setSelectedPath(normalizedPath);
    setActiveTab("file");
    if (!sandboxMode && connection && appId && isWorkspaceImagePath(normalizedPath)) setPreviewImagePath(normalizedPath);
    setAddMenuOpen(false);
    setSearchOpen(false);
    setSearchQuery("");
  }

  const toggleEditorControlsVisible = useCallback(() => {
    setEditorControlsVisible((current) => {
      const next = !current;
      writeEditorControlsVisible(next);
      return next;
    });
  }, []);

  const fileForPath = (path: string): WorkspaceDiffFile =>
    detailedWorkspaceFile(
      currentDiffFileByPath.get(path),
      loadedFiles[path],
      displayDiffFileByPath.get(path),
      path,
    );

  const updateFileDraft = useCallback(
    (path: string, content: string) => {
      setFileDrafts((current) => {
        const draft = current[path];
        const savedContent = draft?.savedContent ?? openFileContentByPath[path] ?? fileForPath(path).content ?? "";
        return { ...current, [path]: { content, savedContent, savedAt: draft?.savedAt } };
      });
      setFileSaveErrors((current) => {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });
    },
    [currentDiffFileByPath, displayDiffFileByPath, loadedFiles, openFileContentByPath],
  );

  const refreshLspDiagnostics = useCallback(
    async (path: string, options: { content?: string; waitForDiagnostics?: boolean } = {}) => {
      if (sandboxMode) return;
      if (!connection || !appId || isWorkspaceImagePath(path)) return;
      const file = fileForPath(path);
      const content = options.content ?? fileDrafts[path]?.content ?? file.content ?? undefined;
      if (content?.endsWith(FILE_TRUNCATED_MARKER)) return;

      const requestSeq = lspRequestSeqRef.current + 1;
      lspRequestSeqRef.current = requestSeq;
      lspAbortControllerRef.current?.abort(new Error("lsp_diagnostics_superseded"));
      const controller = new AbortController();
      lspAbortControllerRef.current = controller;
      setLspCheckingPath(path);
      try {
        const response = await api.workspaceLspTouch(connection, appId, {
          path,
          content,
          waitForDiagnostics: options.waitForDiagnostics ?? true,
        }, {
          signal: controller.signal,
        });
        if (requestSeq !== lspRequestSeqRef.current) return;
        setLspDiagnosticsByPath((current) => ({ ...current, [response.path]: response.diagnostics }));
        setLspServersByPath((current) => ({ ...current, [response.path]: response.servers }));
      } catch (error) {
        if (controller.signal.aborted) return;
        if (requestSeq !== lspRequestSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        setLspDiagnosticsByPath((current) => ({ ...current, [path]: [] }));
        setLspServersByPath((current) => ({
          ...current,
          [path]: [{ id: "lsp", root: "", status: "error", message }],
        }));
      } finally {
        if (lspAbortControllerRef.current === controller) lspAbortControllerRef.current = null;
        if (controller.signal.aborted) return;
        if (requestSeq === lspRequestSeqRef.current) {
          setLspCheckingPath((current) => (current === path ? null : current));
        }
      }
    },
    [appId, connection, currentDiffFileByPath, displayDiffFileByPath, fileDrafts, loadedFiles, sandboxMode],
  );

  const runLspAction = useCallback(
    async (input: WorkspaceMonacoLspActionInput): Promise<WorkspaceLspActionResponse> => {
      if (sandboxMode || !connection || !appId) throw new Error("Workspace LSP is unavailable.");
      return api.workspaceLspAction(connection, appId, input);
    },
    [appId, connection, sandboxMode],
  );

  const saveFile = useCallback(
    async (path: string) => {
      if (!connection || (!appId && !sandboxId)) return;
      if (savingPathRef.current === path) return;
      const draft = fileDrafts[path];
      if (!draft || draft.content === draft.savedContent) return;

      const contentToSave = draft.content;
      const savedAt = Date.now();
      savingPathRef.current = path;
      setSavingPath(path);
      setFileSaveErrors((current) => {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });

      try {
        const savedFile = sandboxMode
          ? await saveSandboxFile(connection, sandboxId!, path, contentToSave)
          : await api.saveWorkspaceFile(connection, appId!, {
            path,
            content: contentToSave,
          });
        setLoadedFiles((current) => ({ ...current, [savedFile.path]: savedFile }));
        setFileDrafts((current) => {
          const currentDraft = current[path];
          if (!currentDraft) return current;
          return {
            ...current,
            [path]: {
              content: currentDraft.content,
              savedContent: contentToSave,
              savedAt,
            },
          };
        });
        if (activeEditorPreferences.languageServers !== "off" && activeEditorPreferences.checkOnSave) {
          await refreshLspDiagnostics(path, { content: contentToSave, waitForDiagnostics: true });
        }
        if (sandboxMode) await refreshSandboxWorkspace({ silent: true });
        else await onRefresh({ silent: true });
      } catch (error) {
        setFileSaveErrors((current) => ({
          ...current,
          [path]: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        if (savingPathRef.current === path) savingPathRef.current = null;
        setSavingPath((current) => (current === path ? null : current));
      }
    },
    [
      activeEditorPreferences.checkOnSave,
      activeEditorPreferences.languageServers,
      appId,
      connection,
      fileDrafts,
      onRefresh,
      refreshLspDiagnostics,
      refreshSandboxWorkspace,
      sandboxId,
      sandboxMode,
    ],
  );

  const selectedFileForEditor = selectedPath ? fileForPath(selectedPath) : null;
  const selectedFileContentForEditor = selectedPath
    ? fileDrafts[selectedPath]?.content ?? selectedFileForEditor?.content ?? null
    : null;
  const selectedFileShowsDiff = Boolean(selectedFileForEditor?.patch && !loadFullFiles);
  const selectedFileIsEditableSource = Boolean(
    activeTab === "file" &&
      !selectedFileShowsDiff &&
      selectedPath &&
      selectedFileContentForEditor != null &&
      !isWorkspaceImagePath(selectedPath) &&
      !(renderMarkdown && isMarkdownPath(selectedPath)) &&
      !selectedFileContentForEditor.endsWith(FILE_TRUNCATED_MARKER),
  );

  useEffect(() => {
    if (activeEditorPreferences.languageServers === "off" || !activeEditorPreferences.diagnosticsWhileEditing) {
      return undefined;
    }
    if (!selectedPath || !selectedFileIsEditableSource || selectedFileContentForEditor == null) return undefined;
    const timeout = window.setTimeout(() => {
      void refreshLspDiagnostics(selectedPath, {
        content: selectedFileContentForEditor,
        waitForDiagnostics: true,
      });
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [
    activeEditorPreferences.diagnosticsWhileEditing,
    activeEditorPreferences.languageServers,
    refreshLspDiagnostics,
    selectedFileContentForEditor,
    selectedFileIsEditableSource,
    selectedPath,
  ]);

  useEffect(() => {
    function handleSaveShortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      if (activeTab !== "file" || !selectedPath) return;
      event.preventDefault();
      if (dirtyFilePaths.has(selectedPath)) void saveFile(selectedPath);
    }

    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, [activeTab, dirtyFilePaths, saveFile, selectedPath]);

  const handleEditorSave = useCallback(() => {
    if (!selectedPath) return;
    if (editorHandleRef.current) editorHandleRef.current.save();
    else void saveFile(selectedPath);
  }, [saveFile, selectedPath]);

  const handleEditorUndo = useCallback(() => {
    editorHandleRef.current?.undo();
  }, []);

  const handleEditorRedo = useCallback(() => {
    editorHandleRef.current?.redo();
  }, []);

  const handleEditorCheck = useCallback(() => {
    if (!selectedPath) return;
    if (activeEditorPreferences.languageServers === "off") return;
    void refreshLspDiagnostics(selectedPath, {
      content: selectedFileContentForEditor ?? undefined,
      waitForDiagnostics: true,
    });
  }, [activeEditorPreferences.languageServers, refreshLspDiagnostics, selectedFileContentForEditor, selectedPath]);

  function closeFileTab(path: string, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (dirtyFilePaths.has(path) && !window.confirm(`Discard unsaved changes to ${path}?`)) return;
    if (dirtyFilePaths.has(path)) {
      setFileDrafts((current) => {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });
      setFileSaveErrors((current) => {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });
    }
    setOpenFilePaths((current) => current.filter((candidate) => candidate !== path));
    if (selectedPath === path) {
      const nextFile = openFiles.find((file) => file.path !== path) ?? null;
      setSelectedPath(nextFile?.path ?? files[0]?.path ?? null);
      if (!nextFile) setActiveTab("files");
    }
  }

  function openFilesTab() {
    setActiveTab("files");
    setAddMenuOpen(false);
    setSearchOpen(false);
  }

  function toggleFileTreeFolder(path: string) {
    setExpandedFileTreeFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function selectBreadcrumbPath(path: string | null) {
    if (path) {
      setExpandedFileTreeFolders((current) => {
        const next = new Set(current);
        for (const folderPath of folderPathAncestors(path)) next.add(folderPath);
        return next;
      });
    }
    setActiveTab("files");
    setAddMenuOpen(false);
    setSearchOpen(false);
  }

  function copyGitApplyCommand() {
    const patches = files.map((file) => file.patch).filter(Boolean).join("\n");
    const command = `git apply <<'PATCH'\n${patches}\nPATCH`;
    void navigator.clipboard?.writeText(command);
  }

  const hasChangedFiles = files.length > 0;
  const hasRepoFiles = repoFiles.length > 0;
  const hasOpenFiles = openFilePaths.length > 0;
  const hasPanelContent = hasGoalDetails || summaryAvailable || hasChangedFiles || hasRepoFiles || hasOpenFiles;
  const visibleTab: DiffTab =
    activeTab === "goal" && hasGoalDetails
      ? "goal"
      : activeTab === "summary" && summaryAvailable
        ? "summary"
        : activeTab === "file" && selectedPath
          ? "file"
          : "files";
  const initializedLocalEmptyMessage = visibleTab === "files" ? "No files to show" : "No local changes";
  const waitingForLocalWorkspace = workspaceKind === "local_project" && !workspaceInitialized && !workspaceError;
  const panelLoading = sandboxMode ? sandboxLoading : loading;
  const panelError = sandboxMode ? sandboxError : workspaceError;
  const sourceStatus = sourceStatusForDiff({
    changedFiles: displayDiff?.filesChanged ?? files.length,
    checkpointStatus,
    dirty: Boolean(displayDiff?.dirty),
    error: panelError,
    loading: panelLoading,
    preservedReadback: usingSandboxSourceReadback,
    sandboxMode,
    sourcePending: sandboxMode && !sandboxId,
  });
  const emptyMessage = panelLoading
    ? "Loading workspace files"
    : panelError
      ? panelError
      : sandboxMode && !sandboxId
        ? sandboxFileSource?.emptyMessage ?? "No sandbox filesystem is available."
      : waitingForLocalWorkspace
        ? "Loading workspace files"
        : workspaceInitialized
          ? initializedLocalEmptyMessage
          : "No local files to show";
  const selectedImagePath = !sandboxMode && selectedPath && isWorkspaceImagePath(selectedPath) ? selectedPath : null;
  const previewImagePreviewPath =
    !sandboxMode && previewImagePath && isWorkspaceImagePath(previewImagePath) ? previewImagePath : null;
  const selectedImageSrc = useWorkspaceImageUrl(connection, appId, selectedImagePath);
  const previewImageSrc = useWorkspaceImageUrl(connection, appId, previewImagePreviewPath);
  const activeToolbarPath = visibleTab === "file" ? selectedPath : null;
  const showRenderMarkdownToggle = Boolean(activeToolbarPath && isMarkdownPath(activeToolbarPath));
  const activeDiagnostics = selectedPath ? lspDiagnosticsByPath[selectedPath] ?? [] : [];
  const activeServers = selectedPath ? lspServersByPath[selectedPath] ?? null : null;
  const editorDiagnosticsChecking = Boolean(selectedPath && lspCheckingPath === selectedPath);
  const showEditorCommandBar = editorControlsVisible && selectedFileIsEditableSource;
  const editorLspEnabled = !sandboxMode && activeEditorPreferences.languageServers !== "off";
  const editorDiagnosticStatus = useMemo(
    () =>
      resolveEditorDiagnosticStatus({
        activeDiagnostics,
        activeServers,
        editorDiagnosticsChecking,
        editorLspEnabled,
        showEditorCommandBar,
      }),
    [activeDiagnostics, activeServers, editorDiagnosticsChecking, editorLspEnabled, showEditorCommandBar],
  );
  const runSubagentLifecycleAction = useCallback(
    async (input: { runId: string; action: SubagentLifecycleAction }) => {
      if (!connection) throw new Error("OpenPond server connection is unavailable.");
      await api.runSubagentLifecycleAction(connection, input.runId, {
        action: input.action,
        reason: "User requested from Goal details.",
      });
      await onRefresh({ silent: true });
    },
    [connection, onRefresh],
  );
  return (
    <>
    <aside className={`workspace-diff-panel ${expanded ? "expanded" : ""}`} aria-label="Workspace diffs">
      {!expanded && (
        <div
          className="workspace-diff-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize diff panel"
          onPointerDown={onResizeStart}
        />
      )}
      <WorkspaceDiffTabs
        addMenuOpen={addMenuOpen}
        expanded={expanded}
        filteredFiles={filteredFiles}
        openFiles={openFiles}
        dirtyFilePaths={dirtyFilePaths}
        goalDetailsAvailable={hasGoalDetails}
        searchOpen={searchOpen}
        searchQuery={searchQuery}
        selectedPath={selectedPath}
        sideChatTabs={sideChatTabs}
        summaryAvailable={summaryAvailable}
        sourceStatus={sourceStatus}
        sourceSwitcher={sourceSwitcher}
        visibleTab={visibleTab}
        onCloseFileTab={closeFileTab}
        onCloseSideChat={onCloseSideChat}
        onCloseSearch={() => setSearchOpen(false)}
        onOpenFile={openFile}
        onOpenBrowser={() => {
          setAddMenuOpen(false);
          setSearchOpen(false);
          onOpenBrowser();
        }}
        onOpenSearch={() => {
          setAddMenuOpen(false);
          setSearchOpen(true);
        }}
        onOpenSideChat={
          onOpenSideChat
            ? () => {
                setAddMenuOpen(false);
                setSearchOpen(false);
                onOpenSideChat();
              }
            : undefined
        }
        onSearchQueryChange={setSearchQuery}
        onSelectFile={(path) => {
          setSelectedPath(path);
          setActiveTab("file");
        }}
        onSelectFiles={openFilesTab}
        onSelectGoal={() => setActiveTab("goal")}
        onSelectSummary={() => {
          setActiveTab("summary");
          setAddMenuOpen(false);
          setSearchOpen(false);
        }}
        onSelectSideChat={onSelectSideChat}
        onToggleAddMenu={() => {
          setAddMenuOpen((open) => !open);
          setSearchOpen(false);
        }}
        onToggleExpanded={onToggleExpanded}
      />

      {visibleTab === "goal" && hasGoalDetails ? (
        <GoalDetailsView
          createRuntime={goalDetails?.createRuntime ?? null}
          goalRuntime={goalDetails?.goalRuntime ?? null}
          subagentRuntime={goalDetails?.subagentRuntime ?? null}
          onRunSubagentLifecycleAction={connection ? runSubagentLifecycleAction : undefined}
        />
      ) : visibleTab === "summary" && summaryAvailable ? (
        <SandboxWorkspaceSummary
          sandboxId={sandboxId}
          connection={connection}
        />
      ) : !hasPanelContent ? (
        <div className="workspace-diff-empty">
          <span>{emptyMessage}</span>
        </div>
      ) : (
        <>
          <WorkspaceDiffToolbar
            canSaveActiveFile={Boolean(selectedPath && dirtyFilePaths.has(selectedPath) && savingPath !== selectedPath)}
            canCheckActiveFile={editorLspEnabled}
            collapsed={collapsed}
            editorControlsVisible={editorControlsVisible}
            editorDiagnosticStatus={editorDiagnosticStatus}
            editorDiagnosticsChecking={editorDiagnosticsChecking}
            hideWhiteSpace={hideWhiteSpace}
            loadFullFiles={loadFullFiles}
            menuOpen={menuOpen}
            renderMarkdown={renderMarkdown}
            showEditorCommandBar={showEditorCommandBar}
            showRenderMarkdownToggle={showRenderMarkdownToggle}
            splitView={splitView}
            wordDiffs={wordDiffs}
            wordWrap={wordWrap}
            onCopyGitApply={copyGitApplyCommand}
            onEditorCheck={handleEditorCheck}
            onEditorRedo={handleEditorRedo}
            onEditorSave={handleEditorSave}
            onEditorUndo={handleEditorUndo}
            onRefresh={() => void (sandboxMode ? refreshSandboxWorkspace() : onRefresh())}
            onToggleCollapsed={() => setCollapsed((value) => !value)}
            onToggleEditorControlsVisible={toggleEditorControlsVisible}
            onToggleHideWhiteSpace={() => setHideWhiteSpace((value) => !value)}
            onToggleLoadFullFiles={() => setLoadFullFiles((value) => !value)}
            onToggleMenu={(open) => setMenuOpen((current) => open ?? !current)}
            onToggleRenderMarkdown={() => setRenderMarkdown((value) => !value)}
            onToggleSplitView={() => setSplitView((value) => !value)}
            onToggleWordDiffs={() => setWordDiffs((value) => !value)}
            onToggleWordWrap={() => setWordWrap((value) => !value)}
          />

          {visibleTab === "files" && (
            <WorkspaceDiffFiles
              diff={displayDiff}
              expandedFolderPaths={expandedFileTreeFolders}
              rootPath={fileRootPath}
              repoFiles={repoFiles}
              onOpenFile={openFile}
              onToggleFolder={toggleFileTreeFolder}
            />
          )}
          {visibleTab === "file" && selectedPath && (
            <FilePreview
              diagnostics={editorLspEnabled ? lspDiagnosticsByPath[selectedPath] ?? [] : []}
              draftContent={fileDrafts[selectedPath]?.content}
              editorRef={editorHandleRef}
              editable={!selectedImageSrc}
              error={fileError}
              file={fileForPath(selectedPath)}
              collapsed={collapsed}
              hideWhiteSpace={hideWhiteSpace}
              imageSrc={selectedImageSrc}
              loading={fileLoadingPath === selectedPath}
              loadFullFiles={loadFullFiles}
              saveError={fileSaveErrors[selectedPath] ?? null}
              saving={savingPath === selectedPath}
              onOpenImage={() => {
                if (selectedImageSrc) setPreviewImagePath(selectedPath);
              }}
              onDraftContentChange={(content) => updateFileDraft(selectedPath, content)}
              onLspAction={editorLspEnabled ? runLspAction : undefined}
              onSave={() => void saveFile(selectedPath)}
              onSelectBreadcrumbPath={selectBreadcrumbPath}
              renderMarkdown={renderMarkdown}
              splitView={splitView}
              wordDiffs={wordDiffs}
              wordWrap={wordWrap}
              workspaceName={workspaceName}
              workspaceRootPath={workspaceRootPath}
            />
          )}
        </>
      )}
    </aside>
    <ImageLightbox
      open={Boolean(previewImageSrc)}
      src={previewImageSrc}
      title={previewImagePath ?? ""}
      onClose={() => setPreviewImagePath(null)}
    />
    </>
  );
}
