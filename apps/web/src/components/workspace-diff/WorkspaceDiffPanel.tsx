import { ErrorToast } from "../common/ErrorToast";
import { htmlContentPreviewUrl, htmlPreviewUrl, isHtmlFilePath } from "../../lib/html-preview";
import { useHydratedClientChoice } from "../../lib/client-choice-storage";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import type { RuntimeEvent, SidebarFileBookmark, SidebarFileStatus, SubagentLifecycleAction, WorkspaceDiffFile, WorkspaceDiffSummary, WorkspaceEditorPreferences, WorkspaceKind, WorkspaceLspActionResponse, WorkspaceLspDiagnostic, WorkspaceLspServerStatus } from "@openpond/contracts";
import { normalizeSidebarFilePath, sidebarFileBookmarkId } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { useWorkspaceImageUrl } from "../../hooks/useWorkspaceImageUrl";
import { localFileWorkspaceId } from "../../lib/local-file-workspace";
import { DEFAULT_APP_PREFERENCES } from "../../lib/app-models";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import { isWorkspaceImagePath } from "../../lib/workspace-images";
import { ImageLightbox } from "../common/ImageLightbox";
import { GoalDetailsView, type GoalDetailsCreateRuntime } from "../goal/GoalDetailsView";
import { SandboxWorkspaceSummary } from "./SandboxWorkspaceSummary";
import { TrainingRunSidebarSummary, type TrainingSidebarSummary } from "../training/TrainingRunSidebarSummary";
import { WorkspaceDiffFiles } from "./WorkspaceDiffFiles";
import { WorkspaceDiffTabs, WorkspaceDiffToolbar } from "./WorkspaceDiffPanelChrome";
import { FileLoadTracker } from "./file-load-tracker";
import { WorkspaceFileRefresh } from "./WorkspaceFileRefresh";
import { FilePreview } from "./WorkspaceFilePreview";
import { WorkspaceFileBookmarkActions } from "./WorkspaceFileBookmarkActions";
import { FILE_TRUNCATED_MARKER, readSandboxFile, sandboxChangedFiles, sandboxRepoFiles, sandboxSourceReadbackDiffFromEvents, saveSandboxFile } from "./workspace-diff-file-model";
import type { WorkspaceMonacoEditorHandle, WorkspaceMonacoLspActionInput } from "./WorkspaceMonacoEditor";
import { useErrorToast } from "../../app/AppToastContext";
import {
  WORKSPACE_TEMPLATE_CONFIG_PATH,
  cloneWorkspaceDiffPanelViewState,
  defaultWorkspaceDiffPanelViewState,
  isDirectoryLikeDiffFile,
  isMarkdownPath,
  isDocumentPath,
  normalizeWorkspaceDiffPanelViewState,
  normalizeWorkspaceDiffPath,
  placeholderFile,
  workspaceDiffPanelViewStatesEqual,
  type DiffTab,
  type FileDraft,
  type SandboxFileSource,
  type WorkspaceDiffPanelViewState,
  type WorkspaceDiffOpenFileRequest,
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
  workspaceId,
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
  filesWithPreview = false,
  openFileRequest,
  readOnly = false,
  sideChatTabs,
  sourceSwitcher,
  tabRequest,
  renderOutputs,
  additionalTabs,
  viewState,
  onRefresh,
  onResizeStart,
  onToggleExpanded,
  onOpenBrowser,
  onOpenBrowserUrl,
  onViewStateChange,
  onCloseSideChat,
  onOpenSideChat,
  onSelectSideChat,
  goalDetails,
  sandboxFileSource,
  trainingSummary,
  sidebarFileBookmarks = [],
  sidebarFileSourceSessionId = null,
  onSetSidebarFileStatus,
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
  filesWithPreview?: boolean;
  openFileRequest?: WorkspaceDiffOpenFileRequest | null;
  readOnly?: boolean;
  sideChatTabs?: WorkspaceDiffSideChatTab[];
  sourceSwitcher?: WorkspaceFileSourceSwitcher | null;
  tabRequest?: WorkspaceDiffTabRequest | null;
  renderOutputs?: (onOpenFile: () => void, tabId: number) => ReactNode;
  additionalTabs?: ReactNode;
  viewState?: WorkspaceDiffPanelViewState | null;
  onRefresh: (options?: WorkspaceDiffRefreshOptions) => Promise<void> | void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleExpanded: () => void;
  onOpenBrowser?: () => void;
  onOpenBrowserUrl: (href: string, options?: { newTab?: boolean }) => void;
  onViewStateChange?: (state: WorkspaceDiffPanelViewState) => void;
  onCloseSideChat?: (panelId: string) => void;
  onOpenSideChat?: () => void;
  onSelectSideChat?: (panelId: string) => void;
  goalDetails?: WorkspaceGoalDetails | null;
  sandboxFileSource?: SandboxFileSource | null;
  trainingSummary?: TrainingSidebarSummary | null;
  sidebarFileBookmarks?: SidebarFileBookmark[];
  sidebarFileSourceSessionId?: string | null;
  onSetSidebarFileStatus?: (
    file: SidebarFileBookmark,
    status: "pinned" | "saved_for_later" | "none",
  ) => void;
}) {
  return (
    <WorkspaceDiffPanelInner
      appId={appId}
      workspaceId={workspaceId}
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
      filesWithPreview={filesWithPreview}
      openFileRequest={openFileRequest}
      readOnly={readOnly}
      sideChatTabs={sideChatTabs ?? []}
      sourceSwitcher={sourceSwitcher ?? null}
      tabRequest={tabRequest ?? null}
      additionalTabs={additionalTabs}
      renderOutputs={renderOutputs ?? null}
      viewState={viewState ?? null}
      onRefresh={onRefresh}
      onResizeStart={onResizeStart}
      onToggleExpanded={onToggleExpanded}
      onOpenBrowser={onOpenBrowser}
      onOpenBrowserUrl={onOpenBrowserUrl}
      onViewStateChange={onViewStateChange}
      onCloseSideChat={onCloseSideChat}
      onOpenSideChat={onOpenSideChat}
      onSelectSideChat={onSelectSideChat}
      goalDetails={goalDetails ?? null}
      sandboxFileSource={sandboxFileSource ?? null}
      trainingSummary={trainingSummary ?? null}
      sidebarFileBookmarks={sidebarFileBookmarks}
      sidebarFileSourceSessionId={sidebarFileSourceSessionId}
      onSetSidebarFileStatus={onSetSidebarFileStatus}
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
    return { ...current, content: loaded.content, contentType: loaded.contentType, contentEncoding: loaded.contentEncoding, readVersion: loaded.readVersion, readStamp: loaded.readStamp };
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
  workspaceId,
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
  filesWithPreview,
  openFileRequest,
  readOnly,
  sideChatTabs,
  sourceSwitcher,
  tabRequest,
  renderOutputs,
  additionalTabs,
  viewState,
  onRefresh,
  onResizeStart,
  onToggleExpanded,
  onOpenBrowser,
  onOpenBrowserUrl,
  onViewStateChange,
  onCloseSideChat,
  onOpenSideChat,
  onSelectSideChat,
  goalDetails,
  sandboxFileSource,
  trainingSummary,
  sidebarFileBookmarks,
  sidebarFileSourceSessionId,
  onSetSidebarFileStatus,
}: {
  appId: string | null;
  workspaceId: string | null;
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
  filesWithPreview: boolean;
  openFileRequest?: WorkspaceDiffOpenFileRequest | null;
  readOnly: boolean;
  sideChatTabs: WorkspaceDiffSideChatTab[];
  sourceSwitcher: WorkspaceFileSourceSwitcher | null;
  tabRequest: WorkspaceDiffTabRequest | null;
  renderOutputs: ((onOpenFile: () => void, tabId: number) => ReactNode) | null;
  additionalTabs?: ReactNode;
  viewState: WorkspaceDiffPanelViewState | null;
  onRefresh: (options?: WorkspaceDiffRefreshOptions) => Promise<void> | void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleExpanded: () => void;
  onOpenBrowser?: () => void;
  onOpenBrowserUrl: (href: string, options?: { newTab?: boolean }) => void;
  onViewStateChange?: (state: WorkspaceDiffPanelViewState) => void;
  onCloseSideChat?: (panelId: string) => void;
  onOpenSideChat?: () => void;
  onSelectSideChat?: (panelId: string) => void;
  goalDetails: WorkspaceGoalDetails | null;
  sandboxFileSource: SandboxFileSource | null;
  trainingSummary: TrainingSidebarSummary | null;
  sidebarFileBookmarks: SidebarFileBookmark[];
  sidebarFileSourceSessionId: string | null;
  onSetSidebarFileStatus?: (
    file: SidebarFileBookmark,
    status: "pinned" | "saved_for_later" | "none",
  ) => void;
}) {
  const initialViewState = viewState ?? defaultWorkspaceDiffPanelViewState();
  const [filesTabOpen, setFilesTabOpen] = useState(!renderOutputs || tabRequest?.tab === "files");
  const [overviewTabs, setOverviewTabs] = useState<number[]>([0]);
  const [activeOverviewId, setActiveOverviewId] = useState(0);
  const nextOverviewId = useRef(1);
  const [tabOrder, setTabOrder] = useState<string[]>(["overview-0", ...initialViewState.openFilePaths]);
  const [activeTab, setActiveTab] = useState<DiffTab>(tabRequest?.tab ?? initialViewState.activeTab);
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
  useHydratedClientChoice(() => setEditorControlsVisible(readEditorControlsVisible()));
  const [wordDiffs, setWordDiffs] = useState(false);
  const [hideWhiteSpace, setHideWhiteSpace] = useState(false);
  const [splitView, setSplitView] = useState(false);
  const [loadedFiles, setLoadedFiles] = useState<Record<string, WorkspaceDiffFile>>({});
  const providedLoads = useRef(new FileLoadTracker());
  const [providedSandboxIds, setProvidedSandboxIds] = useState<Record<string, string | null>>({});
  const [providedFilePaths, setProvidedFilePaths] = useState<Set<string>>(
    () => new Set()
  );
  const [providedImageUrlsByPath, setProvidedImageUrlsByPath] = useState<
    Record<string, string>
  >({});
  const [fileDrafts, setFileDrafts] = useState<Record<string, FileDraft>>({});
  const [expandedFileTreeFolders, setExpandedFileTreeFolders] = useState<Set<string>>(() => new Set());
  const [sandboxDiff, setSandboxDiff] = useState<WorkspaceDiffSummary | null>(null);
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const [lspDiagnosticsByPath, setLspDiagnosticsByPath] = useState<Record<string, WorkspaceLspDiagnostic[]>>({});
  const [lspServersByPath, setLspServersByPath] = useState<Record<string, WorkspaceLspServerStatus[]>>({});
  const [lspCheckingPath, setLspCheckingPath] = useState<string | null>(null);
  const [fileLoadingPath, setFileLoadingPath] = useState<string | null>(null);
  const [htmlPreviewError, setHtmlPreviewError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  useErrorToast(workspaceError, { prefix: "Workspace" });
  useErrorToast(sandboxError, { prefix: "Sandbox files" });
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
  const summaryAvailable = Boolean(trainingSummary) || (sandboxMode && Boolean(sandboxId));
  const sourceKey = sandboxMode ? `sandbox:${sandboxId ?? "pending"}` : `workspace:${appId ?? "none"}`;
  const canOpenRequestedFile = sandboxMode ? Boolean(sandboxId) : Boolean(appId || (connection && openFileRequest && localFileWorkspaceId(openFileRequest.path)));
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
      if (isWorkspaceImagePath(path) || isDocumentPath(path)) continue;
      const file = detailedWorkspaceFile(currentDiffFileByPath.get(path), loadedFiles[path], displayDiffFileByPath.get(path), path);
      if (file.content != null && file.contentEncoding !== "base64") next[path] = file.content;
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
    if (providedFilePaths.size > 0) {
      appliedViewStateRef.current = next;
      return;
    }
    if (workspaceDiffPanelViewStatesEqual(appliedViewStateRef.current, next)) return;
    appliedViewStateRef.current = next;
    reportedViewStateRef.current = next;
    // Workspace hydration must not displace the explicit New tab request.
    setActiveTab(current => tabRequest?.tab === "outputs" && current === "outputs" ? current : next.activeTab);
    setOpenFilePaths(next.openFilePaths);
    setSelectedPath(next.selectedPath);
  }, [viewState, workspaceRootPath, tabRequest?.tab, providedFilePaths]);

  useEffect(() => {
    if (providedFilePaths.size > 0) return;
    if (workspaceDiffPanelViewStatesEqual(reportedViewStateRef.current, currentViewState)) return;
    const next = cloneWorkspaceDiffPanelViewState(currentViewState);
    reportedViewStateRef.current = next;
    appliedViewStateRef.current = next;
    onViewStateChange?.(next);
  }, [currentViewState, onViewStateChange, providedFilePaths]);

  useEffect(() => {
    if (readOnly || sandboxMode || !connection || !appId || !workspaceInitialized || diff || workspaceError) return;
    if (refreshBusyRef.current) return;

    refreshBusyRef.current = true;
    void Promise.resolve(refreshRef.current({ silent: true }))
      .catch(() => {
        // refreshWorkspaceDiff already surfaces errors in the app error state.
      })
      .finally(() => {
        refreshBusyRef.current = false;
      });
  }, [appId, connection, diff, readOnly, sandboxMode, workspaceError, workspaceInitialized]);

  useEffect(() => {
    if (previousSourceKeyRef.current !== sourceKey) {
      previousSourceKeyRef.current = sourceKey;
      lspAbortControllerRef.current?.abort(new Error("lsp_diagnostics_source_changed"));
      lspAbortControllerRef.current = null;
      // Explicit local file tabs own their location. Project hydration or a
      // workspace switch must not erase an in-flight preview from this chat.
      const retained = new Set([...providedFilePaths].filter(path => localFileWorkspaceId(path) && providedSandboxIds[path] === null));
      setOpenFilePaths(current => current.filter(path => retained.has(path)));
      setSelectedPath(current => current && retained.has(current) ? current : null);
      setLoadedFiles(current => Object.fromEntries(Object.entries(current).filter(([path]) => retained.has(path))));
      setProvidedFilePaths(retained);
      setProvidedSandboxIds(current => Object.fromEntries(Object.entries(current).filter(([path]) => retained.has(path))));
      providedLoads.current.retain(retained);
      setProvidedImageUrlsByPath(current => Object.fromEntries(Object.entries(current).filter(([path]) => retained.has(path))));
      setFileDrafts({});
      setExpandedFileTreeFolders(new Set());
      setSandboxDiff(null);
      setSandboxError(null);
      setSandboxLoading(false);
      setLspDiagnosticsByPath({});
      setLspServersByPath({});
      setLspCheckingPath(null);
      setFileLoadingPath(current => current && retained.has(current) ? current : null);
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
    if (!openFileRequest.file && !canOpenRequestedFile) return;
    lastOpenFileRequestIdRef.current = openFileRequest.id;
    if (openFileRequest.file) {
      openProvidedFile(openFileRequest.file, openFileRequest.imageUrl, openFileRequest.source, openFileRequest);
      return;
    }
    openFile(openFileRequest.path, { source: openFileRequest.source });
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
    if (readOnly || sandboxMode || !connection || !appId || !workspaceInitialized) return undefined;

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
  }, [appId, connection, readOnly, sandboxMode, workspaceInitialized]);

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
    if (tabRequest.tab === "files") openFilesTab();
    if (tabRequest.tab === "outputs") {
      if (tabRequest.overview === "experiments") {
        setOverviewTabs(current => current.includes(-1) ? current : [...current, -1]);
        setActiveOverviewId(-1);
        setTabOrder(current => current.includes("overview--1") ? current : [...current, "overview--1"]);
      } else if (tabRequest.overview === "new") {
        const id = overviewTabs.find(value => value !== -1) ?? nextOverviewId.current++;
        setOverviewTabs(current => current.includes(id) ? current : [...current, id]);
        setActiveOverviewId(id);
        setTabOrder(current => current.includes(`overview-${id}`) ? current : [...current, `overview-${id}`]);
      }
    }
    setActiveTab(tabRequest.tab);
  }, [tabRequest]);

  useEffect(() => {
    if (!hasGoalDetails && activeTab === "goal") setActiveTab("files");
  }, [activeTab, hasGoalDetails]);

  useEffect(() => {
    if (!summaryAvailable && activeTab === "summary") setActiveTab("files");
  }, [activeTab, summaryAvailable]);

  const selectedDetailPath = activeTab === "file" || (filesWithPreview && activeTab === "files")
    ? selectedPath
    : null;

  useEffect(() => {
    if (!connection || !selectedDetailPath || providedFilePaths.has(selectedDetailPath)) return undefined;
    if (isWorkspaceImagePath(selectedDetailPath)) {
      setFileError(null);
      setFileLoadingPath((current) => (current === selectedDetailPath ? null : current));
      return undefined;
    }
    const forceReload = fileReloadRequest?.path === selectedDetailPath;
    const diffFile = fileForPath(selectedDetailPath);
    if (readOnly && (diffFile?.content != null || diffFile?.patch)) {
      setFileError(null);
      setFileLoadingPath((current) => (current === selectedDetailPath ? null : current));
      return undefined;
    }
    if (!forceReload && (diffFile?.content != null || (diffFile?.patch && !loadFullFiles))) {
      setFileError(null);
      setFileLoadingPath((current) => (current === selectedDetailPath ? null : current));
      return undefined;
    }

    let cancelled = false;
    const loadedFile = loadedFilesRef.current[selectedDetailPath];
    if (loadedFile?.content == null && (loadFullFiles || !loadedFile?.patch)) setFileLoadingPath(selectedDetailPath);
    setFileError(null);
    const fileWorkspaceId = appId || localFileWorkspaceId(selectedDetailPath);
    const request = sandboxMode
      ? sandboxId
        ? readSandboxFile(connection, sandboxId, selectedDetailPath, runtimeEvents)
        : Promise.reject(new Error(sandboxFileSource?.emptyMessage ?? "No sandbox filesystem is available."))
      : fileWorkspaceId
        ? api.workspaceFile(connection, fileWorkspaceId, selectedDetailPath)
        : Promise.reject(new Error("Workspace files are unavailable."));
    request
      .then((file) => {
        if (cancelled) return;
        setLoadedFiles((current) => {
          const currentFile = current[file.path];
          if (
            currentFile?.content === file.content &&
            currentFile.contentType === file.contentType &&
            currentFile.contentEncoding === file.contentEncoding &&
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
    readOnly,
    runtimeEvents,
    sandboxFileSource?.emptyMessage,
    sandboxId,
    sandboxMode,
    selectedDetailPath,
    providedFilePaths,
  ]);

  function replaceNewTab(key: string) {
    const placeholder = activeTab === "outputs" || (renderOutputs && activeTab === "files" && !filesTabOpen)
      ? `overview-${activeOverviewId}` : null;
    if (placeholder) setOverviewTabs(current => current.filter(id => id !== activeOverviewId));
    setTabOrder(current => {
      if (current.includes(key)) return placeholder ? current.filter(tab => tab !== placeholder) : current;
      if (placeholder && current.includes(placeholder)) return current.map(tab => tab === placeholder ? key : tab);
      return [...current, key];
    });
  }

  function ensureNewTab() {
    if (overviewTabs.some(id => id !== -1)) {
      setActiveOverviewId(overviewTabs.filter(id => id !== -1).at(-1)!);
    } else {
      const id = nextOverviewId.current++;
      setOverviewTabs([id]);
      setActiveOverviewId(id);
      setTabOrder(current => [...current, `overview-${id}`]);
    }
    setActiveTab("outputs");
  }

  function openFile(path: string, options?: { source?: boolean }) {
    setHtmlPreviewError(null);
    const htmlWorkspaceId = sandboxMode ? sandboxId : appId;
    if (isHtmlFilePath(path) && !options?.source && connection && htmlWorkspaceId) {
      void htmlPreviewUrl(connection, htmlWorkspaceId, path, sandboxMode ? "sandbox" : "local").then(onOpenBrowserUrl)
        .catch((error) => setHtmlPreviewError(error instanceof Error ? error.message : "Could not open HTML preview."));
      return;
    }
    const normalizedPath = normalizeWorkspaceDiffPath(path, workspaceRootPath);
    if (!normalizedPath) return;
    providedLoads.current.close(normalizedPath);
    setProvidedSandboxIds(current => {
      if (!Object.hasOwn(current, normalizedPath)) return current;
      const next = { ...current }; delete next[normalizedPath]; return next;
    });
    replaceNewTab(filesWithPreview ? "files" : normalizedPath);
    if (filesWithPreview) setFilesTabOpen(true);
    setProvidedFilePaths((current) => {
      if (!current.has(normalizedPath)) return current;
      const next = new Set(current);
      next.delete(normalizedPath);
      return next;
    });
    setLoadedFiles((current) => {
      if (!(normalizedPath in current)) return current;
      const next = { ...current };
      delete next[normalizedPath];
      return next;
    });
    setProvidedImageUrlsByPath((current) => {
      if (!(normalizedPath in current)) return current;
      const next = { ...current };
      delete next[normalizedPath];
      return next;
    });
    setFileReloadRequest({ id: Date.now(), path: normalizedPath });
    if (!filesWithPreview) {
      setOpenFilePaths((current) => (current.includes(normalizedPath) ? current : [...current, normalizedPath]));
    }
    setSelectedPath(normalizedPath);
    setActiveTab(filesWithPreview ? "files" : "file");
    if (!sandboxMode && connection && appId && isWorkspaceImagePath(normalizedPath)) setPreviewImagePath(normalizedPath);
    setAddMenuOpen(false);
    setSearchOpen(false);
    setSearchQuery("");
  }

  function openProvidedFile(file: WorkspaceDiffFile, imageUrl?: string, source = false, request?: { loading?: boolean; error?: string; loadId?: number; sandboxId?: string | null }) {
    if (isHtmlFilePath(file.path) && file.content != null && !source && connection) {
      void htmlContentPreviewUrl(connection, file.path, file.content).then(onOpenBrowserUrl)
        .catch((error) => setHtmlPreviewError(error instanceof Error ? error.message : "Could not open HTML preview."));
      return;
    }
    const normalizedPath = localFileWorkspaceId(file.path) ? file.path : normalizeWorkspaceDiffPath(file.path, workspaceRootPath);
    if (!normalizedPath) return;
    const loadAction = providedLoads.current.receive(normalizedPath, request);
    if (loadAction === "ignore") return;
    const completing = loadAction === "complete";
    if (completing && !filesWithPreview && !openFilePaths.includes(normalizedPath)) return;
    if (!completing) {
      replaceNewTab(filesWithPreview ? "files" : normalizedPath);
      if (filesWithPreview) setFilesTabOpen(true);
    }
    if (request?.sandboxId !== undefined) setProvidedSandboxIds(current => ({ ...current, [normalizedPath]: request.sandboxId! }));
    const normalizedFile = { ...file, path: normalizedPath };
    setLoadedFiles((current) => request?.loading && current[normalizedPath]?.content != null
      ? current : { ...current, [normalizedPath]: normalizedFile });
    setProvidedFilePaths((current) => {
      const next = new Set(current);
      next.add(normalizedPath);
      return next;
    });
    setProvidedImageUrlsByPath((current) => {
      if (!imageUrl) {
        if (!(normalizedPath in current)) return current;
        const next = { ...current };
        delete next[normalizedPath];
        return next;
      }
      return current[normalizedPath] === imageUrl
        ? current
        : { ...current, [normalizedPath]: imageUrl };
    });
    if (completing) {
      if (selectedPath === normalizedPath) setFileError(request?.error ?? null);
      setFileLoadingPath(current => current === normalizedPath ? null : current);
      return;
    }
    setFileReloadRequest(null);
    setFileError(request?.error ?? null);
    setFileLoadingPath(request?.loading ? normalizedPath : null);
    if (!filesWithPreview) {
      setOpenFilePaths((current) =>
        current.includes(normalizedPath) ? current : [...current, normalizedPath],
      );
    }
    setSelectedPath(normalizedPath);
    setActiveTab(filesWithPreview ? "files" : "file");
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
        if (!controller.signal.aborted && requestSeq === lspRequestSeqRef.current) {
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
  const selectedFileReadOnly = Boolean(
    selectedPath && providedFilePaths.has(selectedPath)
  );
  const selectedFileContentForEditor = selectedPath
    ? fileDrafts[selectedPath]?.content ?? selectedFileForEditor?.content ?? null
    : null;
  const selectedFileShowsDiff = Boolean(selectedFileForEditor?.patch && !loadFullFiles);
  const selectedFileIsEditableSource = Boolean(
    !readOnly &&
      !selectedFileReadOnly &&
      activeTab === "file" &&
      !selectedFileShowsDiff &&
      selectedPath &&
      selectedFileContentForEditor != null &&
      !isWorkspaceImagePath(selectedPath) &&
      !isDocumentPath(selectedPath) &&
      selectedFileForEditor?.contentEncoding !== "base64" &&
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
    providedLoads.current.close(path);
    setProvidedSandboxIds(current => {
      if (!Object.hasOwn(current, path)) return current;
      const next = { ...current }; delete next[path]; return next;
    });
    setOpenFilePaths((current) => current.filter((candidate) => candidate !== path));
    setTabOrder(current => current.filter(key => key !== path));
    if (providedFilePaths.has(path)) {
      setLoadedFiles((current) => {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });
    }
    setProvidedImageUrlsByPath((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    setProvidedFilePaths((current) => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    if (selectedPath === path) {
      const index = openFiles.findIndex(file => file.path === path);
      const nextFile = openFiles[index + 1] ?? openFiles[index - 1] ?? null;
      setSelectedPath(nextFile?.path ?? null);
      if (!nextFile && activeTab === "file") {
        if (renderOutputs) ensureNewTab();
        else setActiveTab("files");
      }
    }
  }

  function openFilesTab() {
    replaceNewTab("files");
    setFilesTabOpen(true);
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
    replaceNewTab("files");
    setFilesTabOpen(true);
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
    activeTab === "outputs" && renderOutputs ? "outputs" :
    activeTab === "goal" && hasGoalDetails
      ? "goal"
      : activeTab === "summary" && summaryAvailable
        ? "summary"
        : activeTab === "file" && selectedPath
          ? "file"
          : renderOutputs && !filesTabOpen ? "outputs" : "files";
  useEffect(() => {
    if (visibleTab !== "outputs" || overviewTabs.length) return;
    // A workspace change can close its file tabs; keep the landing page backed
    // by a real New tab rather than leaving an empty tab strip.
    const id = nextOverviewId.current++;
    setOverviewTabs([id]);
    setActiveOverviewId(id);
    setTabOrder(current => [...current, `overview-${id}`]);
    setActiveTab("outputs");
  }, [overviewTabs.length, visibleTab]);

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
      ? "Workspace files are unavailable"
      : sandboxMode && !sandboxId
        ? sandboxFileSource?.emptyMessage ?? "No sandbox filesystem is available."
      : waitingForLocalWorkspace
        ? "Loading workspace files"
        : workspaceInitialized
          ? initializedLocalEmptyMessage
          : "No local files to show";
  const selectedProvidedImageSrc = selectedPath
    ? providedImageUrlsByPath[selectedPath] ?? null
    : null;
  const selectedWorkspaceImagePath =
    !selectedProvidedImageSrc &&
    !sandboxMode &&
    selectedPath &&
    isWorkspaceImagePath(selectedPath)
      ? selectedPath
      : null;
  const previewProvidedImageSrc = previewImagePath
    ? providedImageUrlsByPath[previewImagePath] ?? null
    : null;
  const previewWorkspaceImagePath =
    !previewProvidedImageSrc &&
    !sandboxMode &&
    previewImagePath &&
    isWorkspaceImagePath(previewImagePath)
      ? previewImagePath
      : null;
  const selectedWorkspaceImageSrc = useWorkspaceImageUrl(
    connection,
    appId,
    selectedWorkspaceImagePath,
  );
  const previewWorkspaceImageSrc = useWorkspaceImageUrl(
    connection,
    appId,
    previewWorkspaceImagePath,
  );
  const selectedImageSrc =
    selectedProvidedImageSrc ?? selectedWorkspaceImageSrc;
  const previewImageSrc = previewProvidedImageSrc ?? previewWorkspaceImageSrc;
  const activeToolbarPath = visibleTab === "file" || (filesWithPreview && visibleTab === "files")
    ? selectedPath
    : null;
  const showRenderMarkdownToggle = Boolean(activeToolbarPath && isMarkdownPath(activeToolbarPath));
  const activeDiagnostics = selectedPath ? lspDiagnosticsByPath[selectedPath] ?? [] : [];
  const activeServers = selectedPath ? lspServersByPath[selectedPath] ?? null : null;
  const editorDiagnosticsChecking = Boolean(selectedPath && lspCheckingPath === selectedPath);
  const showEditorCommandBar = editorControlsVisible && selectedFileIsEditableSource;
  const editorLspEnabled = !readOnly && !selectedFileReadOnly && !sandboxMode && activeEditorPreferences.languageServers !== "off";
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
  const sidebarFileWorkspaceKind = sandboxMode
    ? "sandbox" as const
    : workspaceKind === "local_project"
      ? "local" as const
      : null;
  const sidebarFileBookmarksByPath = useMemo(() => {
    const items = new Map<string, SidebarFileBookmark>();
    if (!sidebarFileWorkspaceKind) return items;
    for (const item of sidebarFileBookmarks) {
      if (item.workspaceKind !== sidebarFileWorkspaceKind || item.workspaceId !== (workspaceId ?? (sidebarFileWorkspaceKind==="local"?localFileWorkspaceId(item.path):null))) continue;
      items.set(item.path, item);
    }
    return items;
  }, [sidebarFileBookmarks, sidebarFileWorkspaceKind, workspaceId]);
  const getSidebarFileStatus = useCallback((path: string): SidebarFileStatus | null => {
    try {
      return sidebarFileBookmarksByPath.get(normalizeSidebarFilePath(path))?.status ?? null;
    } catch {
      return null;
    }
  }, [sidebarFileBookmarksByPath]);
  const setSidebarFileStatusForPath = useCallback((
    path: string,
    status: SidebarFileStatus | "none",
  ) => {
    const bookmarkWorkspaceId=workspaceId??(sidebarFileWorkspaceKind==="local"?localFileWorkspaceId(path):null);
    if (!sidebarFileWorkspaceKind || !bookmarkWorkspaceId || !onSetSidebarFileStatus) return;
    let filePath: string;
    try {
      filePath = normalizeSidebarFilePath(path);
    } catch {
      return;
    }
    const existing = sidebarFileBookmarksByPath.get(filePath);
    const timestamp = new Date().toISOString();
    const file = existing ?? {
      id: sidebarFileBookmarkId({
        workspaceKind: sidebarFileWorkspaceKind,
        workspaceId: bookmarkWorkspaceId,
        path: filePath,
      }),
      workspaceKind: sidebarFileWorkspaceKind,
      workspaceId: bookmarkWorkspaceId,
      workspaceName: workspaceName??"Local files",
      path: filePath,
      status: "pinned" as const,
      order: null,
      sourceSessionId: sidebarFileSourceSessionId,
      available: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    onSetSidebarFileStatus(file, status);
  }, [
    onSetSidebarFileStatus,
    sidebarFileBookmarksByPath,
    sidebarFileSourceSessionId,
    sidebarFileWorkspaceKind,
    workspaceId,
    workspaceName,
  ]);
  const canManageSidebarFiles = Boolean(
    sidebarFileWorkspaceKind && onSetSidebarFileStatus && (workspaceId || (sidebarFileWorkspaceKind==="local" && openFilePaths.some(path=>localFileWorkspaceId(path)))),
  );
  const sidebarFileHeaderActions = selectedPath && canManageSidebarFiles && !selectedFileReadOnly ? (
    <WorkspaceFileBookmarkActions
      currentStatus={getSidebarFileStatus(selectedPath)}
      onSetStatus={(status) => setSidebarFileStatusForPath(selectedPath, status)}
    />
  ) : null;
  const selectedFilePreview = selectedPath ? (
    <div className="workspace-active-file-preview">
    <WorkspaceFileRefresh key={`${sourceKey}:${providedSandboxIds[selectedPath] ?? "local"}:${selectedPath}`} file={fileForPath(selectedPath)} connection={connection}
      workspaceId={appId} sandboxId={Object.hasOwn(providedSandboxIds, selectedPath) ? providedSandboxIds[selectedPath]! : sandboxMode ? sandboxId : null} dirty={dirtyFilePaths.has(selectedPath)}
      onReload={(file, imageUrl) => {
        setLoadedFiles(current => ({ ...current, [selectedPath]: { ...file, path: selectedPath } }));
        setFileDrafts(current => { const next = { ...current }; delete next[selectedPath]; return next; });
        if (imageUrl) setProvidedImageUrlsByPath(current => ({ ...current, [selectedPath]: imageUrl }));
        setFileError(null);
        if (!isDocumentPath(selectedPath) && !isWorkspaceImagePath(selectedPath)) setLoadFullFiles(true);
      }} />
    <FilePreview
      diagnostics={editorLspEnabled ? lspDiagnosticsByPath[selectedPath] ?? [] : []}
      draftContent={fileDrafts[selectedPath]?.content}
      editorRef={editorHandleRef}
      editable={selectedFileIsEditableSource && !selectedImageSrc}
      error={fileError}
      file={fileForPath(selectedPath)}
      collapsed={collapsed}
      hideWhiteSpace={hideWhiteSpace}
      headerActions={sidebarFileHeaderActions}
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
    </div>
  ) : null;
  const fileControlsVisible = Boolean(
    (visibleTab === "file" || (filesWithPreview && visibleTab === "files")) && selectedPath &&
    !isDocumentPath(selectedPath) && !isWorkspaceImagePath(selectedPath) &&
    selectedFileForEditor?.contentEncoding !== "base64"
  );
  const fileToolbar = fileControlsVisible ? (
          <WorkspaceDiffToolbar
            inline
            canSaveActiveFile={Boolean(!readOnly && !selectedFileReadOnly && selectedPath && dirtyFilePaths.has(selectedPath) && savingPath !== selectedPath)}
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
  ) : null;
  return (
    <>
    <aside
      className={`workspace-diff-panel ${visibleTab === "outputs" ? "workspace-diff-overview" : ""} ${expanded ? "expanded" : ""}`}
      id="right-sidebar-files-panel"
      role="tabpanel"
      aria-label="Workspace diffs"
    >
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
        onSelectOutputs={renderOutputs ? () => { setOverviewTabs(current=>current.includes(-1)?current:[...current,-1]);setActiveOverviewId(-1);setTabOrder(current=>current.includes("overview--1")?current:[...current,"overview--1"]);setActiveTab("outputs"); setAddMenuOpen(false); setSearchOpen(false); } : undefined}
        sourceStatus={sourceStatus}
        sourceSwitcher={sourceSwitcher}
        visibleTab={visibleTab}
        additionalTabs={additionalTabs}
        toolbarActions={fileToolbar}
        tabOrder={tabOrder}
        filesTabOpen={filesTabOpen}
        onCloseFilesTab={renderOutputs ? () => {
          setFilesTabOpen(false);
          setTabOrder(current => current.filter(key => key !== "files"));
          if (activeTab === "files") ensureNewTab();
        } : undefined}
        overviewTabs={renderOutputs ? overviewTabs : []}
        activeOverviewId={activeOverviewId}
        onNewOverview={renderOutputs ? () => {
          const id = nextOverviewId.current++;
          setOverviewTabs(current => [...current, id]);
          setTabOrder(current => [...current, `overview-${id}`]);
          setActiveOverviewId(id);
          setActiveTab("outputs");
          setAddMenuOpen(false);
          setSearchOpen(false);
        } : undefined}
        onSelectOverview={id => { setActiveOverviewId(id); setActiveTab("outputs"); }}
        onCloseOverview={id => {
          const remaining = overviewTabs.filter(tabId => tabId !== id);
          setOverviewTabs(remaining);
          setTabOrder(current => current.filter(key => key !== `overview-${id}`));
          if (id === activeOverviewId && activeTab === "outputs") {
            if (remaining.length) setActiveOverviewId(remaining[remaining.length - 1]!);
            else if (renderOutputs) {
              const nextId=nextOverviewId.current++;setOverviewTabs([nextId]);setActiveOverviewId(nextId);setActiveTab("outputs");
              setTabOrder(current=>[...current,`overview-${nextId}`]);
            }
            else if (openFiles.length && selectedPath) setActiveTab("file");
            else if (filesTabOpen) setActiveTab("files");
            else {
              const nextId = nextOverviewId.current++;
              setOverviewTabs([nextId]);
              setTabOrder(current => [...current, `overview-${nextId}`]);
              setActiveOverviewId(nextId);
            }
          }
        }}
        getFileBookmarkStatus={canManageSidebarFiles ? getSidebarFileStatus : undefined}
        onCloseFileTab={closeFileTab}
        onCloseSideChat={onCloseSideChat}
        onCloseSearch={() => setSearchOpen(false)}
        onOpenFile={openFile}
        onOpenBrowser={onOpenBrowser ? () => {
          setAddMenuOpen(false);
          setSearchOpen(false);
          onOpenBrowser();
        } : undefined}
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
        onSetFileBookmarkStatus={canManageSidebarFiles ? setSidebarFileStatusForPath : undefined}
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

      {htmlPreviewError && <ErrorToast error={htmlPreviewError} />}
      {renderOutputs ? overviewTabs.map(id=><div key={id} className="workspace-diff-tool-view" hidden={visibleTab!=="outputs"||activeOverviewId!==id} inert={visibleTab!=="outputs"||activeOverviewId!==id}>
        {renderOutputs(()=>{setSearchOpen(true);setAddMenuOpen(false);},id)}
      </div>) : null}
      {visibleTab === "outputs" && renderOutputs ? null : visibleTab === "goal" && hasGoalDetails ? (
        <GoalDetailsView
          createRuntime={goalDetails?.createRuntime ?? null}
          goalRuntime={goalDetails?.goalRuntime ?? null}
          subagentRuntime={goalDetails?.subagentRuntime ?? null}
          onRunSubagentLifecycleAction={connection ? runSubagentLifecycleAction : undefined}
        />
      ) : visibleTab === "summary" && summaryAvailable ? (
        trainingSummary ? <TrainingRunSidebarSummary summary={trainingSummary}/> : <SandboxWorkspaceSummary sandboxId={sandboxId} connection={connection}/>
      ) : !hasPanelContent ? (
        <div className="workspace-diff-empty">
          <span>{emptyMessage}</span>
        </div>
      ) : (
        <>


          {visibleTab === "files" && (filesWithPreview ? (
            <div className="workspace-diff-files-preview-layout">
              <WorkspaceDiffFiles
                diff={displayDiff}
                expandedFolderPaths={expandedFileTreeFolders}
                rootPath={fileRootPath}
                repoFiles={repoFiles}
                selectedPath={selectedPath}
                getFileBookmarkStatus={canManageSidebarFiles ? getSidebarFileStatus : undefined}
                onOpenFile={openFile}
                onSetFileBookmarkStatus={canManageSidebarFiles ? setSidebarFileStatusForPath : undefined}
                onToggleFolder={toggleFileTreeFolder}
              />
              {selectedFilePreview ?? (
                <div className="workspace-diff-files-preview-empty">Select a file to review its changes.</div>
              )}
            </div>
          ) : (
            <WorkspaceDiffFiles
              diff={displayDiff}
              expandedFolderPaths={expandedFileTreeFolders}
              rootPath={fileRootPath}
              repoFiles={repoFiles}
              selectedPath={selectedPath}
              getFileBookmarkStatus={canManageSidebarFiles ? getSidebarFileStatus : undefined}
              onOpenFile={openFile}
              onSetFileBookmarkStatus={canManageSidebarFiles ? setSidebarFileStatusForPath : undefined}
              onToggleFolder={toggleFileTreeFolder}
            />
          ))}
          {visibleTab === "file" && selectedPath && (
            selectedFilePreview
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
