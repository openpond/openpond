import {
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  OutputRefSchema,
  type Experience,
  type OutputRef,
  type RuntimeEvent,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { ChatMessage } from "../../lib/app-models";
import type { ContextWindowStatus } from "../../lib/context-window";
import { revealLocalFile } from "../../lib/desktop-files";
import { saveLocalFileAs } from "../../lib/desktop-files";
import {
  Activity,
  CheckCircle2,
  FileText,
  FolderOpen,
  Maximize2,
  Minimize2,
  Paperclip,
  Trash2,
} from "../icons";
import { MarkdownText } from "../chat/MarkdownText";
import "../../styles/app-shell/work-sidebar.css";

type WorkSidebarTab = "outputs" | "activity" | "context";

export function WorkSidebarPanel({
  chatMessages,
  connection,
  contextWindowStatus,
  expanded,
  runtimeEvents,
  sessionId,
  showToast,
  onResizeStart,
  onToggleExpanded,
  onUseOutput,
  onHandoffOutput,
  onReviseOutput,
  onAgentPackageInstalled,
}: {
  chatMessages: ChatMessage[];
  connection: ClientConnection | null;
  contextWindowStatus: ContextWindowStatus;
  expanded: boolean;
  runtimeEvents: RuntimeEvent[];
  sessionId: string | null;
  showToast: ShowAppToast;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleExpanded: () => void;
  onUseOutput: (file: File) => void;
  onHandoffOutput: (
    target: Extract<Experience, "chat" | "work">,
    output: OutputRef,
    file: File | null
  ) => Promise<void>;
  onReviseOutput: (output: OutputRef, file: File, annotation: string) => void;
  onAgentPackageInstalled?: () => Promise<void>;
}) {
  const [tab, setTab] = useState<WorkSidebarTab>("outputs");
  const [busyOutputId, setBusyOutputId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    output: OutputRef;
    file: File;
    text: string | null;
    objectUrl: string | null;
  } | null>(null);
  const [revisionNote, setRevisionNote] = useState("");
  const [selectedRevisionByOutputId, setSelectedRevisionByOutputId] = useState<
    Record<string, number>
  >({});
  const outputs = useMemo(
    () => workOutputsFromEvents(runtimeEvents),
    [runtimeEvents]
  );
  const outputSeries = useMemo(() => groupOutputRevisions(outputs), [outputs]);
  const activities = useMemo(
    () => visibleWorkActivities(chatMessages),
    [chatMessages]
  );
  const contextItems = useMemo(
    () => workContextItems(chatMessages),
    [chatMessages]
  );
  useEffect(
    () => () => {
      if (preview?.objectUrl) URL.revokeObjectURL(preview.objectUrl);
    },
    [preview?.objectUrl]
  );

  async function loadLocalOutput(output: OutputRef): Promise<File | null> {
    if (!connection || !sessionId || output.kind !== "file") return null;
    setBusyOutputId(outputRevisionKey(output));
    try {
      const result = await api.workspaceTool(connection, sessionId, {
        action: "work_output_read",
        source: "ui_button",
        args: { outputId: output.id, revision: output.revision },
      });
      if (!result.ok) throw new Error(result.output);
      const data = asRecord(result.data);
      const contentsBase64 =
        typeof data.contentsBase64 === "string" ? data.contentsBase64 : "";
      if (!contentsBase64)
        throw new Error("The output did not include file data.");
      return new File([decodeBase64(contentsBase64)], output.title, {
        type: output.contentType,
      });
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Could not load the output.",
        "error"
      );
      return null;
    } finally {
      setBusyOutputId(null);
    }
  }

  async function previewOutput(output: OutputRef) {
    const file = await loadLocalOutput(output);
    if (!file) return;
    if (preview?.objectUrl) URL.revokeObjectURL(preview.objectUrl);
    const textPreview =
      output.kind === "file" &&
      (output.contentType.startsWith("text/") ||
        output.contentType === "application/json");
    setRevisionNote("");
    setPreview({
      output,
      file,
      text: textPreview ? await file.text() : null,
      objectUrl: textPreview ? null : URL.createObjectURL(file),
    });
  }

  async function useOutput(output: OutputRef) {
    const file = await loadLocalOutput(output);
    if (!file) return;
    onUseOutput(file);
    showToast("Added the output to the task as input.", "success");
  }

  async function handoffOutput(
    target: Extract<Experience, "chat" | "work">,
    output: OutputRef
  ) {
    const file = output.kind === "file" ? await loadLocalOutput(output) : null;
    if (output.kind === "file" && !file) return;
    await onHandoffOutput(target, output, file);
  }

  async function deleteOutput(output: OutputRef) {
    if (!connection || !sessionId) return;
    if (
      !window.confirm(
        `Delete ${output.title} revision ${output.revision} from this device?`
      )
    ) {
      return;
    }
    setBusyOutputId(outputRevisionKey(output));
    try {
      const result = await api.workspaceTool(connection, sessionId, {
        action: "work_output_delete",
        source: "ui_button",
        args: { outputId: output.id, revision: output.revision },
      });
      if (!result.ok) throw new Error(result.output);
      if (preview?.output.id === output.id) setPreview(null);
      showToast("Work output deleted.", "success");
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Could not delete the output.",
        "error"
      );
    } finally {
      setBusyOutputId(null);
    }
  }

  async function installAgentPackage(
    output: Extract<OutputRef, { kind: "agent_package" }>
  ) {
    if (!connection || !sessionId) return;
    if (
      !window.confirm(
        `Add ${output.title} version ${output.versionId} to your active Agents profile?`
      )
    ) {
      return;
    }
    const install = async (overwrite: boolean) =>
      api.workspaceTool(connection, sessionId, {
        action: "work_agent_package_install",
        source: "ui_button",
        args: {
          outputId: output.id,
          revision: output.revision,
          overwrite,
        },
      });
    setBusyOutputId(outputRevisionKey(output));
    try {
      let result;
      try {
        result = await install(false);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Agent installation failed.";
        if (
          !message.includes("already exists") ||
          !window.confirm(
            `${output.agentId} already exists. Replace its active checkout with this immutable version?`
          )
        ) {
          throw error;
        }
        result = await install(true);
      }
      if (!result.ok) throw new Error(result.output);
      await onAgentPackageInstalled?.();
      showToast(
        `${output.title} was added to Agents. Its package remains available in this Work task.`,
        "success"
      );
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Could not add the Agent package.",
        "error"
      );
    } finally {
      setBusyOutputId(null);
    }
  }

  return (
    <aside
      className={`workspace-diff-panel work-sidebar-panel ${
        expanded ? "expanded" : ""
      }`}
      aria-label="Work details"
    >
      {!expanded ? (
        <div
          className="workspace-diff-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Work details"
          onPointerDown={onResizeStart}
        />
      ) : null}
      <div className="workspace-diff-topbar">
        <div
          className="workspace-diff-tabs"
          role="tablist"
          aria-label="Work details"
        >
          {(
            [
              ["outputs", "Outputs"],
              ["activity", "Activity"],
              ["context", "Context"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`workspace-diff-tab ${tab === value ? "active" : ""}`}
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="workspace-diff-toolbar-actions">
          <button
            type="button"
            className="diff-icon-button"
            title={expanded ? "Dock sidebar" : "Expand sidebar"}
            aria-label={expanded ? "Dock sidebar" : "Expand sidebar"}
            onClick={onToggleExpanded}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      <div className="work-sidebar-body">
        {tab === "outputs" ? (
          preview ? (
            <div className="work-output-preview">
              <header>
                <button
                  type="button"
                  onClick={() => {
                    if (preview.objectUrl) {
                      URL.revokeObjectURL(preview.objectUrl);
                    }
                    setPreview(null);
                  }}
                >
                  Outputs
                </button>
                <strong>
                  {preview.output.title} · revision {preview.output.revision}
                </strong>
              </header>
              {preview.text !== null ? (
                <MarkdownText content={preview.text} />
              ) : preview.output.kind === "file" &&
                preview.output.contentType.startsWith("image/") &&
                preview.objectUrl ? (
                <img src={preview.objectUrl} alt={preview.output.title} />
              ) : preview.output.kind === "file" &&
                preview.output.contentType === "application/pdf" &&
                preview.objectUrl ? (
                <iframe src={preview.objectUrl} title={preview.output.title} />
              ) : preview.output.kind === "file" &&
                preview.output.contentType.startsWith("audio/") &&
                preview.objectUrl ? (
                <audio controls src={preview.objectUrl} />
              ) : preview.output.kind === "file" &&
                preview.output.contentType.startsWith("video/") &&
                preview.objectUrl ? (
                <video controls src={preview.objectUrl} />
              ) : (
                <p>
                  This file type uses its native application for detailed
                  review.
                </p>
              )}
              <section className="work-output-annotation">
                <label htmlFor="work-output-revision-note">Revision note</label>
                <textarea
                  id="work-output-revision-note"
                  value={revisionNote}
                  onChange={(event) => setRevisionNote(event.target.value)}
                  placeholder="Describe the exact change to make in the next revision."
                />
                <button
                  type="button"
                  disabled={!revisionNote.trim()}
                  onClick={() => {
                    onReviseOutput(
                      preview.output,
                      preview.file,
                      revisionNote.trim()
                    );
                    showToast(
                      `Prepared revision ${preview.output.revision + 1}.`,
                      "success"
                    );
                  }}
                >
                  Revise this version
                </button>
              </section>
            </div>
          ) : outputSeries.length > 0 ? (
            <div className="work-output-list">
              {outputSeries.map((series) => {
                const output =
                  series.revisions.find(
                    (candidate) =>
                      candidate.revision ===
                      selectedRevisionByOutputId[series.id]
                  ) ?? series.revisions[0]!;
                return (
                  <article className="work-output-card" key={series.id}>
                    <header>
                      <FileText size={16} />
                      <span>
                        <strong>{output.title}</strong>
                        {series.revisions.length > 1 ? (
                          <label className="work-output-version">
                            <span>Version</span>
                            <select
                              value={output.revision}
                              onChange={(event) =>
                                setSelectedRevisionByOutputId((current) => ({
                                  ...current,
                                  [series.id]: Number(event.target.value),
                                }))
                              }
                            >
                              {series.revisions.map((revision) => (
                                <option
                                  key={outputRevisionKey(revision)}
                                  value={revision.revision}
                                >
                                  Revision {revision.revision}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <small>Revision {output.revision}</small>
                        )}
                        <small>{formatOutputDestination(output)}</small>
                      </span>
                    </header>
                    {output.validation.length > 0 ? (
                      <div className="work-output-validation">
                        <CheckCircle2 size={13} />
                        <span>
                          {
                            output.validation.filter(
                              (item) => item.status === "passed"
                            ).length
                          }{" "}
                          checks passed
                        </span>
                      </div>
                    ) : null}
                    <div className="work-output-actions">
                      {output.kind === "file" &&
                      output.location.kind === "local" ? (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              void revealLocalFile(localOutputPath(output))
                            }
                          >
                            <FolderOpen size={13} />
                            Reveal
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              const result = await saveLocalFileAs(
                                localOutputPath(output),
                                output.title
                              );
                              if (result.ok) {
                                showToast(
                                  "Saved a copy of the Work output.",
                                  "success"
                                );
                              } else if (!result.canceled) {
                                showToast(
                                  "Could not save a copy of the Work output.",
                                  "error"
                                );
                              }
                            }}
                          >
                            Save as
                          </button>
                        </>
                      ) : null}
                      {output.kind === "file" ? (
                        <>
                          <button
                            type="button"
                            disabled={
                              busyOutputId === outputRevisionKey(output)
                            }
                            onClick={() => void previewOutput(output)}
                          >
                            Preview
                          </button>
                          <button
                            type="button"
                            disabled={
                              busyOutputId === outputRevisionKey(output)
                            }
                            onClick={() => void useOutput(output)}
                          >
                            <Paperclip size={13} />
                            Use as input
                          </button>
                        </>
                      ) : output.kind === "agent_package" ? (
                        <button
                          type="button"
                          disabled={busyOutputId === outputRevisionKey(output)}
                          onClick={() => void installAgentPackage(output)}
                        >
                          Add to Agents
                        </button>
                      ) : "url" in output && output.url ? (
                        <button
                          type="button"
                          onClick={() =>
                            window.open(
                              output.url!,
                              "_blank",
                              "noopener,noreferrer"
                            )
                          }
                        >
                          Open
                        </button>
                      ) : null}
                      {output.kind === "file" &&
                      output.location.kind === "local" ? (
                        <button
                          type="button"
                          className="danger"
                          disabled={busyOutputId === outputRevisionKey(output)}
                          onClick={() => void deleteOutput(output)}
                        >
                          <Trash2 size={13} />
                          Delete
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busyOutputId === outputRevisionKey(output)}
                        onClick={() => void handoffOutput("chat", output)}
                      >
                        Continue in Chat
                      </button>
                      <button
                        type="button"
                        disabled={busyOutputId === outputRevisionKey(output)}
                        onClick={() =>
                          void handoffOutput("work", output)
                        }
                      >
                        Continue in repository Work
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <WorkEmptyState
              icon={FileText}
              title="No saved outputs yet"
              detail="Finished files and connected results will appear here."
            />
          )
        ) : null}

        {tab === "activity" ? (
          activities.length > 0 ? (
            <div className="work-activity-list">
              {activities.map((item) => (
                <details
                  key={item.id}
                  className={`work-activity-row ${item.state ?? ""}`}
                >
                  <summary>
                    <Activity size={14} />
                    <span>{item.label}</span>
                    <small>{item.state ?? "completed"}</small>
                  </summary>
                  <p>{item.content}</p>
                  {item.detail ? <pre>{item.detail}</pre> : null}
                </details>
              ))}
            </div>
          ) : (
            <WorkEmptyState
              icon={Activity}
              title="No activity yet"
              detail="Commands, tool receipts, and checks appear while Work runs."
            />
          )
        ) : null}

        {tab === "context" ? (
          <div className="work-context">
            <section>
              <h3>Model context</h3>
              <p>{contextWindowStatus.summary}</p>
              <small>{contextWindowStatus.tokensLabel}</small>
            </section>
            <section>
              <h3>Task inputs and sources</h3>
              {contextItems.length > 0 ? (
                <ul>
                  {contextItems.map((item) => (
                    <li key={item.key}>
                      <Paperclip size={13} />
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.detail}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No attached files or cited sources yet.</p>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

export function visibleWorkActivities(
  messages: ChatMessage[]
): NonNullable<ChatMessage["activities"]> {
  return messages
    .flatMap((message) => message.activities ?? [])
    .filter((activity) => activity.kind !== "reasoning")
    .reverse();
}

export function workOutputsFromEvents(events: RuntimeEvent[]): OutputRef[] {
  const outputs = new Map<string, OutputRef>();
  const deleted = new Set<string>();
  for (const event of events) {
    const refs = outputRefsInValue(event.data);
    if (event.action === "work_output_delete" && event.status === "completed") {
      for (const output of refs) {
        const key = outputRevisionKey(output);
        deleted.add(key);
        outputs.delete(key);
      }
      continue;
    }
    if (event.action === "work_output_read") continue;
    for (const output of refs) {
      const key = outputRevisionKey(output);
      if (!deleted.has(key)) outputs.set(key, output);
    }
  }
  return [...outputs.values()].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.revision - left.revision
  );
}

function outputRevisionKey(output: OutputRef): string {
  return `${output.id}:${output.revision}`;
}

function groupOutputRevisions(outputs: OutputRef[]) {
  const groups = new Map<string, OutputRef[]>();
  for (const output of outputs) {
    const current = groups.get(output.id) ?? [];
    current.push(output);
    groups.set(output.id, current);
  }
  return [...groups.entries()]
    .map(([id, revisions]) => ({
      id,
      revisions: revisions.sort(
        (left, right) =>
          right.revision - left.revision ||
          right.createdAt.localeCompare(left.createdAt)
      ),
    }))
    .sort((left, right) =>
      right.revisions[0]!.createdAt.localeCompare(left.revisions[0]!.createdAt)
    );
}

function outputRefsInValue(
  value: unknown,
  output: OutputRef[] = [],
  seen = new Set<string>(),
  depth = 0
): OutputRef[] {
  if (depth > 8 || value == null) return output;
  const parsed = OutputRefSchema.safeParse(value);
  if (parsed.success) {
    const key = `${parsed.data.id}:${parsed.data.revision}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(parsed.data);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      outputRefsInValue(item, output, seen, depth + 1);
    }
    return output;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      outputRefsInValue(child, output, seen, depth + 1);
    }
  }
  return output;
}

function workContextItems(messages: ChatMessage[]) {
  const items = new Map<
    string,
    { key: string; title: string; detail: string }
  >();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      items.set(`attachment:${attachment.id}`, {
        key: `attachment:${attachment.id}`,
        title: attachment.name,
        detail: `${attachment.mediaType} · ${formatBytes(
          attachment.sizeBytes
        )}`,
      });
    }
    for (const source of message.sources ?? []) {
      items.set(`source:${source.id}`, {
        key: `source:${source.id}`,
        title: source.title,
        detail: source.sourceName ?? sourceHostname(source.url),
      });
    }
  }
  return [...items.values()];
}

function WorkEmptyState({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof FileText;
  title: string;
  detail: string;
}) {
  return (
    <div className="work-sidebar-empty">
      <Icon size={22} />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function formatOutputDestination(output: OutputRef): string {
  if (output.kind === "deployment") return "Deployment";
  if (output.kind === "source_change") return "Source change";
  if (output.kind === "external_resource") return output.provider;
  if (output.kind === "agent_package") {
    return `${output.actions.length} action${
      output.actions.length === 1 ? "" : "s"
    }`;
  }
  if (output.location.kind === "local") return formatBytes(output.sizeBytes);
  if (output.location.kind === "managed") return "Managed file";
  return output.location.provider;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${Math.round(value / 1_024)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = window.atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

function localOutputPath(output: OutputRef): string {
  return output.kind === "file" && output.location.kind === "local"
    ? output.location.path
    : "";
}

function sourceHostname(value: string): string {
  try {
    return new URL(value).hostname || value;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
