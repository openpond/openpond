import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type {
  OpenPondProfileCatalogEntry,
  OpenPondProfilePublicationOptionalContent,
  OpenPondProfilePublicationPreview,
  OpenPondProfilePublicationPreviewRequest,
  OpenPondProfilePublicationProvider,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { Github, Globe2, UploadCloud, X } from "../icons";

const OPTIONAL_CONTENT: Array<{
  id: OpenPondProfilePublicationOptionalContent;
  label: string;
  detail: string;
}> = [
  { id: "actions", label: "Actions", detail: "Profile-level reusable actions" },
  { id: "prompts", label: "Prompts", detail: "Shared prompt files" },
  { id: "goals", label: "Goals", detail: "Goal definitions; never started automatically" },
  { id: "evals", label: "Evals", detail: "Evaluation definitions and fixtures" },
  { id: "examples", label: "Examples", detail: "Example inputs and usage" },
  { id: "tasksets", label: "Tasksets", detail: "Training and evaluation tasksets" },
  { id: "extensions", label: "Extension declarations", detail: "Third-party extension metadata" },
];

export function ProfilePublicationDialog({
  connection,
  entry,
  onClose,
  onPublished,
}: {
  connection: ClientConnection;
  entry: OpenPondProfileCatalogEntry;
  onClose: () => void;
  onPublished: (message: string) => void;
}) {
  const [provider, setProvider] = useState<OpenPondProfilePublicationProvider>("github");
  const [owner, setOwner] = useState("");
  const [repository, setRepository] = useState(`${entry.name}-profile`);
  const [visibility, setVisibility] = useState<"private" | "public">("public");
  const [agentIds, setAgentIds] = useState(() => entry.state.agents.filter((agent) => agent.enabled).map((agent) => agent.id));
  const [skillNames, setSkillNames] = useState(() => entry.state.skills.filter((skill) => skill.enabled).map((skill) => skill.name));
  const [optionalContent, setOptionalContent] = useState<OpenPondProfilePublicationOptionalContent[]>([]);
  const [preview, setPreview] = useState<OpenPondProfilePublicationPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "publish" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useMemo<OpenPondProfilePublicationPreviewRequest>(() => ({
    ref: entry.ref,
    selection: { agentIds, skillNames, optionalContent },
    target: {
      provider,
      owner: owner.trim() || null,
      repository: repository.trim(),
      visibility: provider === "github" ? "public" : visibility,
    },
  }), [agentIds, entry.ref, optionalContent, owner, provider, repository, skillNames, visibility]);

  function toggleValue<T extends string>(values: T[], value: T, checked: boolean): T[] {
    return checked ? [...new Set([...values, value])] : values.filter((candidate) => candidate !== value);
  }

  async function createPreview(event: FormEvent) {
    event.preventDefault();
    if (!repository.trim() || busy) return;
    setBusy("preview");
    setError(null);
    try {
      setPreview(await api.profilePublicationPreview(connection, request));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!preview || preview.blockedReasons.length > 0 || busy) return;
    setBusy("publish");
    setError(null);
    try {
      const result = await api.profilePublicationPublish(connection, {
        ...request,
        expectedSourceHash: preview.sourceHash,
        confirmed: true,
      });
      onPublished(`Published ${entry.name} to ${result.owner}/${result.repository}`);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="git-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="git-dialog profile-publication-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-publication-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={createPreview}
      >
        <button className="git-dialog-close" disabled={Boolean(busy)} type="button" aria-label="Close" onClick={onClose}><X size={14} /></button>
        <div className="git-dialog-icon"><UploadCloud size={18} /></div>
        <h2 id="profile-publication-title">Publish {entry.name}</h2>
        <p>Choose the exact Agents, Skills, and optional files to share. OpenPond will show the complete file list before it pushes anything.</p>

        {!preview ? (
          <>
            <fieldset className="profile-publication-fieldset">
              <legend>Destination</legend>
              <label className="profile-publication-provider">
                <input type="radio" checked={provider === "github"} onChange={() => { setProvider("github"); setVisibility("public"); }} />
                <Github size={16} /><span><strong>GitHub</strong><small>Published publicly with your signed-in gh CLI</small></span>
              </label>
              <label className="profile-publication-provider">
                <input type="radio" checked={provider === "openpond_git"} onChange={() => { setProvider("openpond_git"); setVisibility("private"); }} />
                <Globe2 size={16} /><span><strong>OpenPond Git</strong><small>Private by default; uses the same repository format</small></span>
              </label>
            </fieldset>
            <div className="profile-publication-target-fields">
              {provider === "github" ? (
                <label className="git-dialog-field"><span>GitHub owner (optional)</span><input value={owner} placeholder="Uses gh account" onChange={(event) => setOwner(event.currentTarget.value)} /></label>
              ) : null}
              <label className="git-dialog-field"><span>Repository</span><input value={repository} onChange={(event) => setRepository(event.currentTarget.value)} /></label>
              {provider === "openpond_git" ? (
                <label className="git-dialog-field"><span>Visibility</span><select value={visibility} onChange={(event) => setVisibility(event.currentTarget.value as "private" | "public")}><option value="private">Private</option><option value="public">Public</option></select></label>
              ) : null}
            </div>
            <PublicationSelectionGroup title="Agents" empty="No Agents in this Profile">
              {entry.state.agents.map((agent) => (
                <SelectionRow key={agent.id} checked={agentIds.includes(agent.id)} label={agent.name} detail={agent.path} onChange={(checked) => setAgentIds((current) => toggleValue(current, agent.id, checked))} />
              ))}
            </PublicationSelectionGroup>
            <PublicationSelectionGroup title="Skills" empty="No Skills in this Profile">
              {entry.state.skills.map((skill) => (
                <SelectionRow key={skill.name} checked={skillNames.includes(skill.name)} label={skill.name} detail={skill.description || skill.path} onChange={(checked) => setSkillNames((current) => toggleValue(current, skill.name, checked))} />
              ))}
            </PublicationSelectionGroup>
            <PublicationSelectionGroup title="Optional content" empty="">
              {OPTIONAL_CONTENT.map((item) => (
                <SelectionRow key={item.id} checked={optionalContent.includes(item.id)} label={item.label} detail={item.detail} onChange={(checked) => setOptionalContent((current) => toggleValue(current, item.id, checked))} />
              ))}
            </PublicationSelectionGroup>
          </>
        ) : (
          <PublicationPreview preview={preview} />
        )}

        {error ? <div className="profile-dialog-warning">{error}</div> : null}
        <div className="git-dialog-footer">
          <button className="git-dialog-secondary" disabled={Boolean(busy)} type="button" onClick={preview ? () => setPreview(null) : onClose}>{preview ? "Back" : "Cancel"}</button>
          {preview ? (
            <button className="git-dialog-primary" disabled={Boolean(busy) || preview.blockedReasons.length > 0} type="button" onClick={() => void publish()}>
              <UploadCloud size={14} /><span>{busy === "publish" ? "Publishing" : preview.replacesExisting ? "Confirm and replace" : "Confirm and publish"}</span>
            </button>
          ) : (
            <button className="git-dialog-primary" disabled={Boolean(busy) || !repository.trim()} type="submit">{busy === "preview" ? "Building preview" : "Review exact files"}</button>
          )}
        </div>
      </form>
    </div>
  );
}

function PublicationSelectionGroup({ title, empty, children }: { title: string; empty: string; children: ReactNode }) {
  const childCount = Array.isArray(children) ? children.length : children ? 1 : 0;
  return <fieldset className="profile-publication-fieldset"><legend>{title}</legend>{childCount ? children : <span className="profile-publication-empty">{empty}</span>}</fieldset>;
}

function SelectionRow({ checked, label, detail, onChange }: { checked: boolean; label: string; detail: string; onChange: (checked: boolean) => void }) {
  return <label className="profile-publication-selection"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} /><span><strong>{label}</strong><small>{detail}</small></span></label>;
}

function PublicationPreview({ preview }: { preview: OpenPondProfilePublicationPreview }) {
  const totalBytes = preview.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return (
    <div className="profile-publication-preview">
      <div className="profile-dialog-summary"><strong>{preview.files.length} files · {formatBytes(totalBytes)}</strong><span>{preview.sourceRevision?.slice(0, 10) ?? "No source revision"}</span></div>
      {preview.blockedReasons.map((reason) => <div className="profile-dialog-warning" key={reason}>{reason}</div>)}
      {preview.warnings.map((warning) => <div className="profile-publication-warning" key={warning}>{warning}</div>)}
      <div className="profile-publication-file-list" aria-label="Exact files to publish">
        {preview.files.map((file) => <div key={file.path}><span title={file.path}>{file.path}</span><small>{file.category} · {formatBytes(file.sizeBytes)}</small></div>)}
      </div>
      {preview.excludedFiles.length ? <details><summary>{preview.excludedFiles.length} excluded sensitive/runtime files</summary>{preview.excludedFiles.map((file) => <code key={file}>{file}</code>)}</details> : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
