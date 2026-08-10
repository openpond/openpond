import {
  useEffect,
  useMemo,
  useState,
} from "react";
import type { FileOutputRef } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { revealLocalFile, saveLocalFileAs } from "../../lib/desktop-files";
import {
  Code2,
  Download,
  File as FileIcon,
  FileAudio,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FolderOpen,
  ImageIcon,
  Loader2,
  Presentation,
  X,
  type LucideIcon,
} from "../icons";
import {
  outputFilePresentation,
  type OutputFileType,
} from "./output-file-model";
import { useCachedWorkOutputs } from "./useCachedWorkOutputs";

const ALL_FILE_TYPES = "all";
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

type OutputPreview = {
  file: File;
  objectUrl: string | null;
  output: FileOutputRef;
  text: string | null;
};

export function OutputsPage({
  connection,
  onViewChat,
}: {
  connection: ClientConnection | null;
  onViewChat: (sessionId: string) => void;
}) {
  const { error: outputsError, loading, outputs } = useCachedWorkOutputs(connection);
  const [filter, setFilter] = useState(ALL_FILE_TYPES);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyOutputKey, setBusyOutputKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<OutputPreview | null>(null);

  useEffect(
    () => () => {
      if (preview?.objectUrl) URL.revokeObjectURL(preview.objectUrl);
    },
    [preview?.objectUrl]
  );

  const fileTypes = useMemo(
    () =>
      Array.from(
        new Set(outputs.map((output) => outputFilePresentation(output).label))
      ).sort((left, right) => left.localeCompare(right)),
    [outputs]
  );
  const effectiveFilter = fileTypes.includes(filter) ? filter : ALL_FILE_TYPES;
  const visibleOutputs = useMemo(
    () =>
      effectiveFilter === ALL_FILE_TYPES
        ? outputs
        : outputs.filter(
            (output) => outputFilePresentation(output).label === effectiveFilter
          ),
    [effectiveFilter, outputs]
  );

  async function previewOutput(output: FileOutputRef) {
    if (!connection) return;
    const key = outputKey(output);
    setBusyOutputKey(key);
    setActionError(null);
    try {
      const result = await api.workspaceTool(connection, output.sourceTaskId, {
        action: "work_output_read",
        source: "ui_button",
        args: { outputId: output.id, revision: output.revision },
      });
      if (!result.ok) throw new Error(result.output);
      const data = asRecord(result.data);
      const contentsBase64 =
        typeof data.contentsBase64 === "string" ? data.contentsBase64 : "";
      if (!contentsBase64) throw new Error("The output did not include file data.");
      const file = new File([decodeBase64(contentsBase64)], output.title, {
        type: output.contentType,
      });
      const presentation = outputFilePresentation(output);
      const textPreview = presentation.type === "text" || presentation.type === "html";
      if (preview?.objectUrl) URL.revokeObjectURL(preview.objectUrl);
      setPreview({
        file,
        objectUrl: textPreview ? null : URL.createObjectURL(file),
        output,
        text: textPreview ? await file.text() : null,
      });
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyOutputKey(null);
    }
  }

  async function saveOutput(output: FileOutputRef) {
    if (output.location.kind !== "local") return;
    const result = await saveLocalFileAs(output.location.path, output.title);
    if (!result.ok && !result.canceled) {
      setActionError("Could not save a copy of the Work output.");
    }
  }

  return (
    <section
      aria-label="My files"
      className={`outputs-view${preview ? " detail-open" : ""}`}
    >
      <div className="outputs-scroll">
        <div className="outputs-content">
          {outputs.length > 0 ? (
            <header className="outputs-header">
              <label className="outputs-filter">
                <select
                  aria-label="Filter files by file type"
                  onChange={(event) => setFilter(event.target.value)}
                  value={effectiveFilter}
                >
                  <option value={ALL_FILE_TYPES}>All file types</option>
                  {fileTypes.map((fileType) => (
                    <option key={fileType} value={fileType}>
                      {fileType}
                    </option>
                  ))}
                </select>
              </label>
            </header>
          ) : null}

          {outputsError || actionError ? (
            <p className="outputs-error">{actionError ?? outputsError}</p>
          ) : null}
          {!connection ? (
            <OutputMessage>Connect to the local OpenPond server to view outputs.</OutputMessage>
          ) : loading && outputs.length === 0 ? (
            <div className="outputs-loading" role="status">
              <Loader2 className="outputs-spin" size={16} />
              <span>Loading files</span>
            </div>
          ) : outputs.length === 0 ? (
            <OutputMessage>Files created in Work will appear here.</OutputMessage>
          ) : visibleOutputs.length === 0 ? (
            <OutputMessage>No files match this file type.</OutputMessage>
          ) : (
            <div className="outputs-grid" data-testid="desktop-output-cards">
              {visibleOutputs.map((output) => {
                const presentation = outputFilePresentation(output);
                const key = outputKey(output);
                return (
                  <article className="output-card" key={key}>
                    <button
                      aria-label={`Preview ${output.title}`}
                      className="output-card-main"
                      disabled={busyOutputKey === key}
                      onClick={() => void previewOutput(output)}
                      type="button"
                    >
                      <span className="output-card-icon">
                        <OutputTypeIcon type={presentation.type} />
                      </span>
                      <span className="output-card-copy">
                        <strong>{output.title}</strong>
                        <small>
                          {presentation.label} · {formatBytes(output.sizeBytes)}
                        </small>
                        <small>
                          Revision {output.revision} ·{" "}
                          <time dateTime={output.createdAt}>
                            {formatDateTime(output.createdAt)}
                          </time>
                        </small>
                      </span>
                      {busyOutputKey === key ? (
                        <Loader2 className="outputs-spin" size={15} />
                      ) : null}
                    </button>
                    <div className="output-card-actions">
                      {output.location.kind === "local" ? (
                        <button
                          aria-label={`Download ${output.title}`}
                          className="output-download-button"
                          onClick={() => void saveOutput(output)}
                          title="Download"
                          type="button"
                        >
                          <Download aria-hidden="true" size={14} />
                        </button>
                      ) : null}
                      <button
                        onClick={() => onViewChat(output.sourceTaskId)}
                        type="button"
                      >
                        View chat
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {preview ? (
        <OutputPreviewPanel
          onClose={() => setPreview(null)}
          onSave={() => void saveOutput(preview.output)}
          onViewChat={() => onViewChat(preview.output.sourceTaskId)}
          preview={preview}
        />
      ) : null}
    </section>
  );
}

function OutputPreviewPanel({
  onClose,
  onSave,
  onViewChat,
  preview,
}: {
  onClose: () => void;
  onSave: () => void;
  onViewChat: () => void;
  preview: OutputPreview;
}) {
  const presentation = outputFilePresentation(preview.output);
  return (
    <aside aria-label={`${preview.output.title} preview`} className="output-detail">
      <header className="output-detail-header">
        <div>
          <h2>{preview.output.title}</h2>
          <p>
            {presentation.label} · Revision {preview.output.revision}
          </p>
        </div>
        <button aria-label="Close output preview" onClick={onClose} type="button">
          <X size={16} />
        </button>
      </header>
      <div className="output-preview-surface">
        {preview.text !== null ? (
          presentation.type === "html" ? (
            <iframe sandbox="" srcDoc={preview.text} title={preview.output.title} />
          ) : (
            <pre>{preview.text}</pre>
          )
        ) : presentation.type === "image" && preview.objectUrl ? (
          <img alt={preview.output.title} src={preview.objectUrl} />
        ) : presentation.type === "pdf" && preview.objectUrl ? (
          <iframe src={preview.objectUrl} title={preview.output.title} />
        ) : presentation.type === "audio" && preview.objectUrl ? (
          <audio controls src={preview.objectUrl} />
        ) : presentation.type === "video" && preview.objectUrl ? (
          <video controls src={preview.objectUrl} />
        ) : (
          <div className="output-native-preview">
            <OutputTypeIcon type={presentation.type} />
            <p>This file type uses its native application for detailed review.</p>
          </div>
        )}
      </div>
      <div className="output-detail-actions">
        {preview.output.location.kind === "local" ? (
          <>
            <button
              onClick={() => void revealLocalFile(preview.output.location.kind === "local" ? preview.output.location.path : "")}
              type="button"
            >
              <FolderOpen size={14} />
              Reveal
            </button>
            <button
              aria-label={`Download ${preview.output.title}`}
              className="output-download-button"
              onClick={onSave}
              title="Download"
              type="button"
            >
              <Download aria-hidden="true" size={14} />
            </button>
          </>
        ) : null}
        <button onClick={onViewChat} type="button">View chat</button>
      </div>
    </aside>
  );
}

function OutputTypeIcon({ type }: { type: OutputFileType }) {
  const Icon = outputTypeIcon(type);
  return <Icon aria-hidden="true" size={18} />;
}

function outputTypeIcon(type: OutputFileType): LucideIcon {
  if (type === "audio") return FileAudio;
  if (type === "html" || type === "text") return Code2;
  if (type === "image") return ImageIcon;
  if (type === "presentation") return Presentation;
  if (type === "table") return FileSpreadsheet;
  if (type === "video") return FileVideo;
  if (type === "file") return FileIcon;
  return FileText;
}

function OutputMessage({ children }: { children: string }) {
  return <p className="outputs-empty">{children}</p>;
}

function outputKey(output: FileOutputRef): string {
  return `${output.sourceTaskId}:${output.id}:${output.revision}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatDateTime(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? "Unknown date" : dateTimeFormatter.format(date);
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not load Work outputs.";
}
