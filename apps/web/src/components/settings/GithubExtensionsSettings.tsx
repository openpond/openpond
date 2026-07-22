import { useCallback, useState, type FormEvent } from "react";
import type {
  OpenPondExtension,
  OpenPondExtensionCatalog,
  OpenPondExtensionPreview,
} from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";
import { ChevronRight, Github, Loader2, Plus, RefreshCw, Trash2 } from "../icons";

type ExtensionBusyState =
  | "preview"
  | "install"
  | "update-all"
  | `update:${string}`
  | `remove:${string}`
  | null;

export function GithubExtensionsSettings({
  catalog,
  connection,
  onCatalog,
  onError,
  onOpenExtension,
  onToast,
}: {
  catalog: OpenPondExtensionCatalog;
  connection: ClientConnection | null;
  onCatalog: (catalog: OpenPondExtensionCatalog) => void;
  onError: (message: string | null) => void;
  onOpenExtension: (extension: OpenPondExtension) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
}) {
  const [source, setSource] = useState("");
  const [requestedRef, setRequestedRef] = useState("");
  const [preview, setPreview] = useState<OpenPondExtensionPreview | null>(null);
  const [busy, setBusy] = useState<ExtensionBusyState>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setLocalError(message);
    onError(message);
    onToast?.(message, "error");
  }, [onError, onToast]);

  const clearError = useCallback(() => {
    setLocalError(null);
    onError(null);
  }, [onError]);

  const previewExtension = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    if (!connection || !source.trim() || busy) return;
    clearError();
    setBusy("preview");
    try {
      const result = await api.extensionPreview(connection, {
        source: source.trim(),
        ...(requestedRef.trim() ? { ref: requestedRef.trim() } : {}),
      });
      setPreview(result);
    } catch (error) {
      setPreview(null);
      reportError(error);
    } finally {
      setBusy(null);
    }
  }, [busy, clearError, connection, reportError, requestedRef, source]);

  const installPreview = useCallback(async () => {
    if (!connection || !preview || busy) return;
    clearError();
    setBusy("install");
    try {
      const result = await api.extensionAdd(connection, {
        source: preview.repositoryUrl,
        ref: preview.requestedRef,
      });
      onCatalog(result.catalog);
      setSource("");
      setRequestedRef("");
      setPreview(null);
      onToast?.(`Installed ${result.extension.owner}/${result.extension.repo}.`, "success");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }, [busy, clearError, connection, onCatalog, onToast, preview, reportError]);

  const updateExtension = useCallback(async (extension: OpenPondExtension) => {
    if (!connection || busy) return;
    clearError();
    setBusy(`update:${extension.id}`);
    try {
      const result = await api.extensionUpdate(connection, extension);
      onCatalog(result.catalog);
      const unchanged = result.extension.resolvedCommit === extension.resolvedCommit
        && result.extension.packageHash === extension.packageHash;
      onToast?.(
        unchanged
          ? `${extension.owner}/${extension.repo} is already current.`
          : `Updated ${extension.owner}/${extension.repo}.`,
        "success",
      );
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }, [busy, clearError, connection, onCatalog, onToast, reportError]);

  const updateAll = useCallback(async () => {
    if (!connection || busy || catalog.extensions.length === 0) return;
    clearError();
    setBusy("update-all");
    try {
      const result = await api.extensionUpdateAll(connection);
      onCatalog(result.catalog);
      const message = `Updated ${result.updated.length}; ${result.unchanged.length} already current${
        result.failed.length ? `; ${result.failed.length} failed` : ""
      }.`;
      onToast?.(message, result.failed.length ? "error" : "success");
      if (result.failed.length) setLocalError(result.failed.map((failure) => failure.error).join(" "));
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }, [busy, catalog.extensions.length, clearError, connection, onCatalog, onToast, reportError]);

  const removeExtension = useCallback(async (extension: OpenPondExtension) => {
    if (!connection || busy) return;
    if (!window.confirm(
      `Remove ${extension.owner}/${extension.repo} and its ${extension.skills.length} installed skill${
        extension.skills.length === 1 ? "" : "s"
      }? Profile and built-in skills will not be changed.`,
    )) return;
    clearError();
    setBusy(`remove:${extension.id}`);
    try {
      const result = await api.extensionRemove(connection, extension);
      onCatalog(result.catalog);
      onToast?.(`Removed ${extension.owner}/${extension.repo}.`, "success");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }, [busy, clearError, connection, onCatalog, onToast, reportError]);

  const sourceChanged = useCallback((value: string) => {
    setSource(value);
    setPreview(null);
    setLocalError(null);
  }, []);
  const refChanged = useCallback((value: string) => {
    setRequestedRef(value);
    setPreview(null);
    setLocalError(null);
  }, []);

  return (
    <div className="account-list native-skills-list github-extensions-list">
      <div className="account-list-heading github-extensions-heading">
        <span>Third-party extensions</span>
        <div className="github-extensions-heading-actions">
          <small>{catalog.extensions.length} installed from GitHub</small>
          <button
            className="settings-secondary compact"
            disabled={!connection || busy !== null || catalog.extensions.length === 0}
            type="button"
            onClick={() => void updateAll()}
          >
            {busy === "update-all" ? <Loader2 className="settings-spin" size={13} /> : <RefreshCw size={13} />}
            Update all
          </button>
        </div>
      </div>

      <form className="github-extension-add" onSubmit={(event) => void previewExtension(event)}>
        <div className="github-extension-add-copy">
          <strong>Add a GitHub skill pack</strong>
          <span>Use a skills-CLI-compatible owner/repo or GitHub URL. OpenPond installs it locally without running setup code.</span>
        </div>
        <label>
          <span>Repository</span>
          <input
            disabled={!connection || busy !== null}
            placeholder="owner/repo"
            value={source}
            onChange={(event) => sourceChanged(event.target.value)}
          />
        </label>
        <label className="github-extension-ref-input">
          <span>Branch, tag, or SHA</span>
          <input
            disabled={!connection || busy !== null}
            placeholder="Default branch"
            value={requestedRef}
            onChange={(event) => refChanged(event.target.value)}
          />
        </label>
        <button className="settings-secondary" disabled={!connection || !source.trim() || busy !== null} type="submit">
          {busy === "preview" ? <Loader2 className="settings-spin" size={14} /> : <Github size={14} />}
          {busy === "preview" ? "Checking" : "Preview"}
        </button>
      </form>

      {localError || catalog.error ? (
        <div className="github-extension-message error" role="alert">{localError ?? catalog.error}</div>
      ) : null}

      {preview ? (
        <div className="github-extension-preview">
          <div>
            <strong>{preview.owner}/{preview.repo}</strong>
            <span>{preview.skills.length} skill{preview.skills.length === 1 ? "" : "s"} at {preview.resolvedCommit.slice(0, 12)}</span>
          </div>
          <div className="github-extension-preview-skills">
            {preview.skills.map((skill) => (
              <span key={skill.relativePath}>{skill.name}</span>
            ))}
          </div>
          <button className="settings-secondary" disabled={busy !== null} type="button" onClick={() => void installPreview()}>
            {busy === "install" ? <Loader2 className="settings-spin" size={14} /> : <Plus size={14} />}
            {busy === "install" ? "Installing" : "Install extension"}
          </button>
        </div>
      ) : null}

      {catalog.extensions.length ? catalog.extensions.map((extension) => {
        const updating = busy === `update:${extension.id}`;
        const removing = busy === `remove:${extension.id}`;
        return (
          <div className="github-extension-row" key={extension.id}>
            <button
              aria-label={`Open ${extension.owner}/${extension.repo} extension source`}
              className="github-extension-open"
              disabled={!connection || busy !== null}
              type="button"
              onClick={() => onOpenExtension(extension)}
            >
              <span className="native-skill-icon" aria-hidden="true"><Github size={17} /></span>
              <span className="native-skill-identity">
                <strong>{extension.owner}/{extension.repo}</strong>
                <span>{extension.skills.map((skill) => skill.name).join(", ")}</span>
              </span>
              <span className="native-skill-provider">
                <strong>{extension.skills.length} skill{extension.skills.length === 1 ? "" : "s"}</strong>
                <span>{extension.requestedRef} · {extension.resolvedCommit.slice(0, 12)}</span>
              </span>
              <span className={`native-skill-status ${extension.validationStatus === "valid" ? "" : "invalid"}`}>
                {extension.validationStatus === "valid" ? "Ready" : "Needs attention"}
              </span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
            <span className="github-extension-row-actions">
              <button
                aria-label={`Update ${extension.owner}/${extension.repo}`}
                className="settings-icon-button ghost"
                disabled={busy !== null}
                title="Update extension"
                type="button"
                onClick={() => void updateExtension(extension)}
              >
                {updating ? <Loader2 className="settings-spin" size={14} /> : <RefreshCw size={14} />}
              </button>
              <button
                aria-label={`Remove ${extension.owner}/${extension.repo}`}
                className="settings-icon-button ghost danger"
                disabled={busy !== null}
                title="Remove extension"
                type="button"
                onClick={() => void removeExtension(extension)}
              >
                {removing ? <Loader2 className="settings-spin" size={14} /> : <Trash2 size={14} />}
              </button>
            </span>
          </div>
        );
      }) : (
        <div className="skills-settings-empty">No third-party extensions installed.</div>
      )}
    </div>
  );
}
