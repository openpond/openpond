import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ExternalLink, FileText, LoaderCircle, Maximize2, Minimize2, RefreshCw } from "../icons";
import { api, type ClientConnection } from "../../api";
import type {
  SandboxFileEntry,
  SandboxGitDiff,
  SandboxGitStatus,
  SandboxProcess,
  SandboxPtySession,
  SandboxRecord,
  SandboxReplayArtifact,
  SandboxReplayRecord,
} from "../../lib/sandbox-types";

type SandboxWorkspacePanelProps = {
  sandboxId: string;
  connection: ClientConnection | null;
  workspaceName: string | null;
  expanded: boolean;
  onOpenBrowserUrl?: (href: string, options?: { newTab?: boolean }) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleExpanded: () => void;
};

type BusyState = "overview" | "replay" | "artifacts" | null;
type FilePreviewState =
  | { status: "idle"; path: string | null; contents: string | null; message: string | null }
  | { status: "loading"; path: string; contents: null; message: null };

export function SandboxWorkspacePanel({
  sandboxId,
  connection,
  workspaceName,
  expanded,
  onOpenBrowserUrl,
  onResizeStart,
  onToggleExpanded,
}: SandboxWorkspacePanelProps) {
  const [sandbox, setSandbox] = useState<SandboxRecord | null>(null);
  const [replays, setReplays] = useState<SandboxReplayRecord[]>([]);
  const [selectedReplayId, setSelectedReplayId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<SandboxReplayArtifact[]>([]);
  const [selectedArtifactPath, setSelectedArtifactPath] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [files, setFiles] = useState<SandboxFileEntry[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreviewState>({
    status: "idle",
    path: null,
    contents: null,
    message: null,
  });
  const [gitStatus, setGitStatus] = useState<SandboxGitStatus | null>(null);
  const [gitDiff, setGitDiff] = useState<SandboxGitDiff | null>(null);
  const [processes, setProcesses] = useState<SandboxProcess[]>([]);
  const [ptys, setPtys] = useState<SandboxPtySession[]>([]);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [busy, setBusy] = useState<BusyState>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedReplayIdRef = useRef<string | null>(null);

  const selectedReplay = useMemo(
    () => replays.find((replay) => replay.id === selectedReplayId) ?? null,
    [replays, selectedReplayId],
  );
  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.path === selectedArtifactPath) ?? null,
    [artifacts, selectedArtifactPath],
  );
  const replayScope = useMemo(
    () => ({
      ...(sandbox?.teamId ? { teamId: sandbox.teamId } : {}),
      ...(sandbox?.projectId ? { projectId: sandbox.projectId } : {}),
    }),
    [sandbox?.projectId, sandbox?.teamId],
  );
  const sourceRows = useMemo(() => sandboxAccessRows(sandbox), [sandbox]);
  const changedFileCount = useMemo(() => gitChangedFileCount(gitStatus), [gitStatus]);

  const refreshWorkspace = useCallback(
    async (targetSandboxId = sandboxId) => {
      if (!connection) return;
      setWorkspaceBusy(true);
      try {
        const [filesResult, statusResult, diffResult, processesResult, ptysResult] = await Promise.allSettled([
          api.sandboxFiles(connection, targetSandboxId, { recursive: true, maxEntries: 250 }),
          api.sandboxGitStatus(connection, targetSandboxId),
          api.sandboxGitDiff(connection, targetSandboxId, {}),
          api.sandboxProcesses(connection, targetSandboxId),
          api.sandboxPtys(connection, targetSandboxId),
        ]);

        if (filesResult.status === "fulfilled") {
          const nextFiles = filesResult.value.files;
          setFiles(nextFiles);
          setSelectedFilePath((current) => {
            if (current && nextFiles.some((file) => file.path === current && file.type === "file")) return current;
            return nextFiles.find((file) => file.type === "file")?.path ?? null;
          });
        }
        if (statusResult.status === "fulfilled") setGitStatus(statusResult.value.status);
        if (diffResult.status === "fulfilled") setGitDiff(diffResult.value.diff);
        if (processesResult.status === "fulfilled") setProcesses(processesResult.value.processes);
        if (ptysResult.status === "fulfilled") setPtys(ptysResult.value.ptys);

        const rejected = [filesResult, statusResult, diffResult, processesResult, ptysResult].find(
          (result) => result.status === "rejected",
        );
        if (rejected?.status === "rejected") {
          setError(rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason));
        }
      } finally {
        setWorkspaceBusy(false);
      }
    },
    [connection, sandboxId],
  );

  const applySelectedReplay = useCallback((replay: SandboxReplayRecord | null) => {
    selectedReplayIdRef.current = replay?.id ?? null;
    setSelectedReplayId(replay?.id ?? null);
    setArtifacts(replay?.artifacts ?? []);
    setLogs(replay?.logs ?? []);
    setSelectedArtifactPath((current) => {
      if (replay?.artifacts.some((artifact) => artifact.path === current)) return current;
      return replay?.artifacts[0]?.path ?? null;
    });
  }, []);

  const refreshOverview = useCallback(async () => {
    if (!connection) {
      setError("OpenPond App server is not connected.");
      return;
    }
    setBusy("overview");
    setError(null);
    try {
      const sandboxResult = await api.sandbox(connection, sandboxId);
      const nextSandbox = sandboxResult.sandbox;
      const replayResult = await api.sandboxReplays(connection, {
        teamId: nextSandbox.teamId,
        ...(nextSandbox.projectId ? { projectId: nextSandbox.projectId } : {}),
      });
      const matchingReplays = replayResult.replays
        .filter((replay) => replayMatchesSandbox(nextSandbox, replay))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      const selected =
        matchingReplays.find((replay) => replay.id === selectedReplayIdRef.current) ??
        matchingReplays[0] ??
        null;
      setSandbox(nextSandbox);
      setReplays(matchingReplays);
      applySelectedReplay(selected);
      void refreshWorkspace(nextSandbox.id);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(null);
    }
  }, [applySelectedReplay, connection, refreshWorkspace, sandboxId]);

  const refreshSelectedReplay = useCallback(async () => {
    if (!connection || !selectedReplay) return;
    setBusy("replay");
    setError(null);
    try {
      const result = await api.sandboxReplay(connection, selectedReplay.id, replayScope);
      setReplays((current) =>
        current
          .map((replay) => (replay.id === result.replay.id ? result.replay : replay))
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
      );
      applySelectedReplay(result.replay);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(null);
    }
  }, [applySelectedReplay, connection, replayScope, selectedReplay]);

  const refreshArtifacts = useCallback(async () => {
    if (!connection || !selectedReplay) return;
    setBusy("artifacts");
    setError(null);
    try {
      const result = await api.sandboxReplayArtifacts(connection, selectedReplay.id, replayScope);
      setArtifacts(result.artifacts);
      setSelectedArtifactPath((current) => {
        if (result.artifacts.some((artifact) => artifact.path === current)) return current;
        return result.artifacts[0]?.path ?? null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(null);
    }
  }, [connection, replayScope, selectedReplay]);

  useEffect(() => {
    selectedReplayIdRef.current = selectedReplayId;
  }, [selectedReplayId]);

  useEffect(() => {
    selectedReplayIdRef.current = null;
    setSandbox(null);
    setReplays([]);
    setFiles([]);
    setSelectedFilePath(null);
    setGitStatus(null);
    setGitDiff(null);
    setProcesses([]);
    setPtys([]);
    applySelectedReplay(null);
    void refreshOverview();
  }, [applySelectedReplay, refreshOverview]);

  useEffect(() => {
    if (!connection || !selectedFilePath) {
      setFilePreview({ status: "idle", path: null, contents: null, message: null });
      return;
    }
    let cancelled = false;
    setFilePreview({ status: "loading", path: selectedFilePath, contents: null, message: null });
    void api
      .sandboxDownloadFile(connection, sandboxId, selectedFilePath, { maxBytes: 64 * 1024 })
      .then((result) => {
        if (cancelled) return;
        if (result.file.isBinary) {
          setFilePreview({ status: "idle", path: selectedFilePath, contents: null, message: "Binary file" });
          return;
        }
        setFilePreview({
          status: "idle",
          path: selectedFilePath,
          contents: result.contents.length > 6000 ? `${result.contents.slice(0, 6000)}\n...` : result.contents,
          message: result.file.truncated ? "Preview truncated" : null,
        });
      })
      .catch((loadError) => {
        if (!cancelled) {
          setFilePreview({
            status: "idle",
            path: selectedFilePath,
            contents: null,
            message: loadError instanceof Error ? loadError.message : String(loadError),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connection, sandboxId, selectedFilePath]);

  return (
    <aside
      className={`workspace-diff-panel sandbox-workspace-panel ${expanded ? "expanded" : ""}`}
      aria-label="Sandbox workspace"
    >
      {!expanded && (
        <div
          className="workspace-diff-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sandbox panel"
          onPointerDown={onResizeStart}
        />
      )}
      <div className="sandbox-workspace-topbar">
        <div>
          <strong>{workspaceName ?? "Sandbox"}</strong>
          <span>{shortId(sandboxId)}</span>
        </div>
        <div className="sandbox-workspace-actions">
          <button
            type="button"
            className="diff-icon-button"
            title="Refresh sandbox"
            aria-label="Refresh sandbox"
            disabled={busy !== null}
            onClick={() => void refreshOverview()}
          >
            {busy === "overview" ? <LoaderCircle className="spinning" size={14} /> : <RefreshCw size={14} />}
          </button>
          <button
            type="button"
            className="diff-icon-button"
            title={expanded ? "Collapse panel" : "Expand panel"}
            aria-label={expanded ? "Collapse panel" : "Expand panel"}
            onClick={onToggleExpanded}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      <div className="sandbox-workspace-content">
        {error && <div className="sandbox-workspace-error">{error}</div>}
        {sandbox ? (
          <>
            <section className="sandbox-workspace-section">
              <div className="sandbox-workspace-heading">
                <h3>Overview</h3>
                <span>{sandbox.state}</span>
              </div>
              <dl className="sandbox-workspace-kv">
                <div>
                  <dt>Team</dt>
                  <dd>{shortId(sandbox.teamId)}</dd>
                </div>
                <div>
                  <dt>Runtime</dt>
                  <dd>{sandbox.runtimeDriver}</dd>
                </div>
                <div>
                  <dt>Spend</dt>
                  <dd>
                    {formatUsd(sandbox.reservation.capturedUsd)} / {formatUsd(sandbox.budget.maxUsd)}
                  </dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{formatDate(sandbox.updatedAt)}</dd>
                </div>
              </dl>
            </section>

            <section className="sandbox-workspace-section">
              <div className="sandbox-workspace-heading">
                <h3>Access</h3>
                <span>{sourceRows.length}</span>
              </div>
              <div className="sandbox-workspace-access-list">
                {sourceRows.map((row) => (
                  <div className="sandbox-workspace-access-row" key={`${row.type}-${row.label}`}>
                    <span>{row.label}</span>
                    <small>{row.value}</small>
                  </div>
                ))}
              </div>
            </section>

            <section className="sandbox-workspace-section">
              <div className="sandbox-workspace-heading">
                <h3>Files</h3>
                <button
                  type="button"
                  className="diff-icon-button"
                  title="Refresh files"
                  aria-label="Refresh files"
                  disabled={workspaceBusy}
                  onClick={() => void refreshWorkspace()}
                >
                  {workspaceBusy ? <LoaderCircle className="spinning" size={14} /> : <RefreshCw size={14} />}
                </button>
              </div>
              {files.length > 0 ? (
                <>
                  <div className="sandbox-workspace-file-list">
                    {files.slice(0, 120).map((file) => (
                      <button
                        type="button"
                        className={file.path === selectedFilePath ? "selected" : ""}
                        disabled={file.type !== "file"}
                        key={`${file.type}:${file.path}`}
                        onClick={() => setSelectedFilePath(file.path)}
                      >
                        <FileText size={13} />
                        <span>{file.path}</span>
                        <small>{file.type === "directory" ? "directory" : formatBytes(file.sizeBytes)}</small>
                      </button>
                    ))}
                  </div>
                  <SandboxFilePreview preview={filePreview} />
                </>
              ) : (
                <p className="sandbox-workspace-empty">No workspace files loaded.</p>
              )}
            </section>

            <section className="sandbox-workspace-section">
              <div className="sandbox-workspace-heading">
                <h3>Changes</h3>
                <span>{changedFileCount}</span>
              </div>
              {gitStatus ? (
                <dl className="sandbox-workspace-kv">
                  <div>
                    <dt>Branch</dt>
                    <dd>{gitStatus.branch ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>Clean</dt>
                    <dd>{gitStatus.clean ? "yes" : "no"}</dd>
                  </div>
                  <div>
                    <dt>Ahead</dt>
                    <dd>{gitStatus.ahead}</dd>
                  </div>
                  <div>
                    <dt>Behind</dt>
                    <dd>{gitStatus.behind}</dd>
                  </div>
                </dl>
              ) : (
                <p className="sandbox-workspace-empty">Git status unavailable.</p>
              )}
              {gitDiff?.diff ? (
                <pre className="sandbox-workspace-log">{gitDiff.diff.length > 12000 ? `${gitDiff.diff.slice(0, 12000)}\n...` : gitDiff.diff}</pre>
              ) : (
                <p className="sandbox-workspace-empty">No sandbox diff.</p>
              )}
            </section>

            <section className="sandbox-workspace-section">
              <div className="sandbox-workspace-heading">
                <h3>Terminal</h3>
                <span>{processes.length + ptys.length}</span>
              </div>
              {processes.length > 0 || ptys.length > 0 ? (
                <div className="sandbox-workspace-process-list">
                  {processes.slice(0, 8).map((process) => (
                    <div className="sandbox-workspace-process-row" key={process.id}>
                      <span>{process.command}</span>
                      <small>
                        {process.status} / {formatBytes(process.outputBytes)}
                      </small>
                    </div>
                  ))}
                  {ptys.slice(0, 8).map((pty) => (
                    <div className="sandbox-workspace-process-row" key={pty.id}>
                      <span>{pty.command}</span>
                      <small>
                        pty {pty.status} / {formatBytes(pty.outputBytes)}
                      </small>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="sandbox-workspace-empty">No terminal sessions or processes.</p>
              )}
            </section>

            <section className="sandbox-workspace-section">
              <div className="sandbox-workspace-heading">
                <h3>Previews</h3>
                <span>{sandbox.previewPorts.length}</span>
              </div>
              {sandbox.previewPorts.length > 0 ? (
                <div className="sandbox-workspace-preview-list">
                  {sandbox.previewPorts.map((preview) => (
                    <a
                      key={preview.id}
                      href={preview.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        if (!onOpenBrowserUrl) return;
                        event.preventDefault();
                        onOpenBrowserUrl(preview.url);
                      }}
                    >
                      <ExternalLink size={13} />
                      <span>{preview.label ?? `:${preview.port}`}</span>
                      <small>{preview.access}</small>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="sandbox-workspace-empty">No open preview ports.</p>
              )}
            </section>

            <section className="sandbox-workspace-section">
              <div className="sandbox-workspace-heading">
                <h3>Replays</h3>
                <span>{replays.length}</span>
              </div>
              {replays.length > 0 ? (
                <div className="sandbox-workspace-replay-list">
                  {replays.slice(0, 8).map((replay) => (
                    <button
                      type="button"
                      className={replay.id === selectedReplayId ? "selected" : ""}
                      key={replay.id}
                      onClick={() => applySelectedReplay(replay)}
                    >
                      <span>{shortId(replay.id)}</span>
                      <small>
                        {replay.state} / {formatDate(replay.updatedAt)}
                      </small>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="sandbox-workspace-empty">No replays captured for this sandbox.</p>
              )}
            </section>

            {selectedReplay && (
              <section className="sandbox-workspace-section">
                <div className="sandbox-workspace-heading">
                  <h3>Replay</h3>
                  <button
                    type="button"
                    className="diff-icon-button"
                    title="Refresh replay"
                    aria-label="Refresh replay"
                    disabled={busy !== null}
                    onClick={() => void refreshSelectedReplay()}
                  >
                    {busy === "replay" ? <LoaderCircle className="spinning" size={14} /> : <RefreshCw size={14} />}
                  </button>
                </div>
                <dl className="sandbox-workspace-kv">
                  <div>
                    <dt>State</dt>
                    <dd>{selectedReplay.state}</dd>
                  </div>
                  <div>
                    <dt>Exit</dt>
                    <dd>{selectedReplay.exitCode ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>Cleanup</dt>
                    <dd>{selectedReplay.cleanup.status}</dd>
                  </div>
                  <div>
                    <dt>Budget</dt>
                    <dd>{formatUsd(selectedReplay.budget.maxUsd)}</dd>
                  </div>
                </dl>
                {selectedReplay.error && <p className="sandbox-workspace-error">{selectedReplay.error}</p>}
              </section>
            )}

            {selectedReplay && (
              <section className="sandbox-workspace-section">
                <div className="sandbox-workspace-heading">
                  <h3>Artifacts</h3>
                  <button
                    type="button"
                    className="diff-icon-button"
                    title="Refresh artifacts"
                    aria-label="Refresh artifacts"
                    disabled={busy !== null}
                    onClick={() => void refreshArtifacts()}
                  >
                    {busy === "artifacts" ? <LoaderCircle className="spinning" size={14} /> : <RefreshCw size={14} />}
                  </button>
                </div>
                {artifacts.length > 0 ? (
                  <>
                    <div className="sandbox-workspace-artifact-list">
                      {artifacts.map((artifact) => (
                        <button
                          type="button"
                          className={artifact.path === selectedArtifactPath ? "selected" : ""}
                          key={artifact.path}
                          onClick={() => setSelectedArtifactPath(artifact.path)}
                        >
                          <FileText size={13} />
                          <span>{artifact.path}</span>
                          <small>
                            {artifact.status} / {formatBytes(artifact.sizeBytes)}
                          </small>
                        </button>
                      ))}
                    </div>
                    <ArtifactPreview artifact={selectedArtifact} />
                  </>
                ) : (
                  <p className="sandbox-workspace-empty">No replay artifacts are available.</p>
                )}
              </section>
            )}

            {logs.length > 0 && (
              <section className="sandbox-workspace-section">
                <div className="sandbox-workspace-heading">
                  <h3>Logs</h3>
                  <span>{logs.length}</span>
                </div>
                <pre className="sandbox-workspace-log">{logs.slice(-16).join("\n")}</pre>
              </section>
            )}
          </>
        ) : (
          <div className="sandbox-workspace-loading">
            {busy === "overview" ? <LoaderCircle className="spinning" size={16} /> : null}
            <span>{busy === "overview" ? "Loading sandbox" : "Sandbox unavailable"}</span>
          </div>
        )}
      </div>
    </aside>
  );
}

function ArtifactPreview({ artifact }: { artifact: SandboxReplayArtifact | null }) {
  const preview = artifact ? decodeArtifactPreview(artifact) : null;
  if (!artifact) return null;
  return (
    <div className="sandbox-workspace-artifact-preview">
      <div className="sandbox-workspace-artifact-title">
        <ChevronDown size={13} />
        <span>{artifact.path}</span>
      </div>
      {preview ? (
        <pre>{preview}</pre>
      ) : (
        <p>{artifact.error ?? "Captured artifact is not text-previewable in the rail."}</p>
      )}
    </div>
  );
}

function SandboxFilePreview({ preview }: { preview: FilePreviewState }) {
  if (preview.status === "loading") {
    return (
      <div className="sandbox-workspace-artifact-preview">
        <p>Loading {preview.path}</p>
      </div>
    );
  }
  if (!preview.path) return null;
  return (
    <div className="sandbox-workspace-artifact-preview">
      <div className="sandbox-workspace-artifact-title">
        <ChevronDown size={13} />
        <span>{preview.path}</span>
      </div>
      {preview.contents !== null ? <pre>{preview.contents}</pre> : <p>{preview.message ?? "No preview"}</p>}
      {preview.contents !== null && preview.message ? <p>{preview.message}</p> : null}
    </div>
  );
}

function replayMatchesSandbox(sandbox: SandboxRecord, replay: SandboxReplayRecord): boolean {
  if (replay.sourceSandboxId === sandbox.id || replay.sandboxId === sandbox.id) return true;
  return Boolean(sandbox.snapshots?.some((snapshot) => snapshot.id === replay.snapshotId));
}

function sandboxAccessRows(sandbox: SandboxRecord | null): Array<{ type: string; label: string; value: string }> {
  if (!sandbox) return [];
  const rows: Array<{ type: string; label: string; value: string }> = [];
  const metadata = asRecord(sandbox.metadata);
  const source = asRecord(metadata.sandboxSource);
  if (sandbox.projectId) {
    rows.push({
      type: "source",
      label: "Internal source",
      value: `${shortId(sandbox.projectId)}${typeof sandbox.repoRef === "string" && sandbox.repoRef ? ` / ${sandbox.repoRef}` : ""}`,
    });
  }
  if (typeof source.kind === "string") {
    rows.push({
      type: "source-kind",
      label: "Source grant",
      value: String(source.kind),
    });
  }
  for (const lease of sandbox.integrationLeases ?? []) {
    rows.push({
      type: `integration-${lease.leaseId}`,
      label: `${lease.provider} lease`,
      value: lease.expiresAt ? `expires ${formatDate(lease.expiresAt)}` : "active",
    });
  }
  for (const preview of sandbox.previewPorts) {
    rows.push({
      type: `preview-${preview.id}`,
      label: "Preview access",
      value: `${preview.label ?? `:${preview.port}`} / ${preview.access}`,
    });
  }
  for (const mount of sandbox.volumeMounts ?? []) {
    rows.push({
      type: `volume-${mount.id}`,
      label: "Volume mount",
      value: `${mount.name} / ${mount.status}`,
    });
  }
  return rows.length > 0 ? rows : [{ type: "none", label: "Workspace", value: "sandbox-scoped" }];
}

function gitChangedFileCount(status: SandboxGitStatus | null): number {
  if (!status?.porcelain) return 0;
  return status.porcelain.split("\n").filter((line) => line.trim()).length;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function decodeArtifactPreview(artifact: SandboxReplayArtifact): string | null {
  if (!artifact.contentsBase64 || typeof globalThis.atob !== "function") return null;
  let text: string;
  try {
    text = globalThis.atob(artifact.contentsBase64);
  } catch {
    return null;
  }
  if (!isTextArtifact(artifact.path, text)) return null;
  const normalized = artifact.path.endsWith(".json") ? prettyJson(text) : text;
  return normalized.length > 4000 ? `${normalized.slice(0, 4000)}\n...` : normalized;
}

function isTextArtifact(path: string, text: string): boolean {
  if (/\.(csv|json|log|md|sql|txt|yaml|yml)$/i.test(path)) return true;
  return !/[\u0000-\u0008\u000E-\u001F]/.test(text.slice(0, 512));
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function shortId(value: string): string {
  return value.length > 10 ? `${value.slice(0, 8)}...` : value;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatUsd(value: string | number | null | undefined): string {
  const amount = Number(value ?? 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: amount >= 10 ? 2 : 4,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatBytes(value: number | null | undefined): string {
  if (value == null) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
