import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  HarnessReleaseDiffPayload,
  HarnessReleaseDiffRequest,
  WorkspaceDiffSummary,
} from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";
import { WorkspaceDiffPanel } from "../workspace-diff/WorkspaceDiffPanel";

export type HarnessReleaseDiffSelection = HarnessReleaseDiffRequest & {
  title: string;
};

function shortHash(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "initial";
}

export function HarnessReleaseDiffSidebar({
  connection,
  expanded,
  onResizeStart,
  onToggleExpanded,
  selection,
}: {
  connection: ClientConnection;
  expanded: boolean;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleExpanded: () => void;
  selection: HarnessReleaseDiffSelection;
}) {
  const [diff, setDiff] = useState<HarnessReleaseDiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setDiff(await api.harnessReleaseDiff(connection, selection));
    } catch (cause) {
      setDiff(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [connection, selection]);

  useEffect(() => {
    void load();
  }, [load]);

  const workspaceDiff = useMemo<WorkspaceDiffSummary | null>(() => diff ? ({
    appId: `harness:${selection.workspaceId}`,
    repoPath: selection.title,
    initialized: true,
    dirty: diff.filesChanged > 0,
    filesChanged: diff.filesChanged,
    additions: diff.additions,
    deletions: diff.deletions,
    repoFiles: diff.files.map((file) => file.path),
    files: diff.files,
    error: null,
    updatedAt: "",
  }) : null, [diff, selection.title, selection.workspaceId]);

  const workspaceName = `${selection.title} · ${shortHash(selection.baseRelease?.contentHash)} → ${shortHash(selection.targetRelease.contentHash)}`;

  return (
    <WorkspaceDiffPanel
      appId={`harness:${selection.workspaceId}`}
      workspaceId={`harness:${selection.targetRelease.contentHash}`}
      workspaceKind="local_project"
      connection={connection}
      diff={workspaceDiff}
      editorPreferences={null}
      expanded={expanded}
      filesWithPreview
      loading={loading}
      onOpenBrowserUrl={() => undefined}
      onRefresh={load}
      onResizeStart={onResizeStart}
      onToggleExpanded={onToggleExpanded}
      readOnly
      workspaceError={error}
      workspaceInitialized
      workspaceName={workspaceName}
    />
  );
}
