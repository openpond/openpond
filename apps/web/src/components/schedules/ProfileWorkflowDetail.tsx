import { useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { CHAT_ATTACHMENT_LIMITS } from "@openpond/contracts";
import type { ClientConnection, ProfileWorkflowDiscovery } from "../../api";
import { composerAttachmentKind, createAttachmentId, readComposerAttachmentPayload } from "../chat/ComposerAttachments";
import { RotateCcw } from "../icons";
import { launchProfileWorkflow } from "../profile/launch-profile-workflow";
import { DetailSection, ScheduleDetailPanel } from "./ScheduledWorkDetailParts";

export function ProfileWorkflowDetail({
  catalog,
  connection,
  detailExpanded,
  entry,
  onClose,
  onDetailResizeStart,
  onOpenSession,
  onToggleDetailExpanded,
}: {
  catalog: ProfileWorkflowDiscovery;
  connection: ClientConnection;
  detailExpanded: boolean;
  entry: ProfileWorkflowDiscovery["workflows"][number];
  onClose: () => void;
  onDetailResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onOpenSession: (sessionId: string) => void;
  onToggleDetailExpanded: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [inputText, setInputText] = useState("{}");
  const [workspaceTarget, setWorkspaceTarget] = useState<"local" | "hosted">(
    catalog.profileRef.source === "local" ? "local" : "hosted",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflow = entry.workflow;

  async function run(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const value = JSON.parse(inputText) as unknown;
      if (files.length > CHAT_ATTACHMENT_LIMITS.maxAttachments) {
        throw new Error(`Choose at most ${CHAT_ATTACHMENT_LIMITS.maxAttachments} files.`);
      }
      const attachments = await Promise.all(files.map(async (file) => {
        if (file.size > CHAT_ATTACHMENT_LIMITS.maxAttachmentBytes) {
          throw new Error(`${file.name} exceeds the attachment size limit.`);
        }
        return readComposerAttachmentPayload({
          id: createAttachmentId(), file, name: file.name,
          mediaType: file.type || "application/octet-stream",
          sizeBytes: file.size, kind: composerAttachmentKind(file),
        });
      }));
      await launchProfileWorkflow({
        connection, catalog, workflowId: workflow.id, value, prompt, attachments,
        workspaceTarget, onSessionCreated: onOpenSession,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <ScheduleDetailPanel
      detailExpanded={detailExpanded}
      kind="workflow"
      label={`${workflow.label} details`}
      onClose={onClose}
      onDetailResizeStart={onDetailResizeStart}
      onToggleDetailExpanded={onToggleDetailExpanded}
    >
      <div className="scheduled-detail-header">
        <div>
          <div className="scheduled-detail-title-row"><h2>Workflow details</h2></div>
          <p>{workflow.label}</p>
        </div>
      </div>
      <DetailSection title="Description"><p>{workflow.description}</p></DetailSection>
      <DetailSection title="Source">
        <p>workflows/{workflow.id}/{workflow.invocation.kind === "instructions" ? "PROMPT.md" : "ACTION.json"}</p>
        <p>Revision {entry.binding.sourceRevision.slice(0, 12)} · Release {entry.binding.harnessRelease.contentHash.slice(0, 12)}</p>
      </DetailSection>
      {workflow.skillPaths.length > 0 ? (
        <DetailSection title="Skills"><p>{workflow.skillPaths.join(", ")}</p></DetailSection>
      ) : null}
      {workflow.invocation.kind === "instructions" ? (
        <DetailSection title="Instructions"><pre className="scheduled-prompt">{workflow.invocation.instructions}</pre></DetailSection>
      ) : null}
      <DetailSection title="Start a run">
        <form className="scheduled-profile-workflow-form" onSubmit={(event) => void run(event)}>
          <label htmlFor="scheduled-profile-workflow-prompt">Instructions for this run</label>
          <textarea id="scheduled-profile-workflow-prompt" onChange={(event) => setPrompt(event.target.value)} value={prompt} />
          <label htmlFor="scheduled-profile-workflow-files">Files for this run</label>
          <input id="scheduled-profile-workflow-files" type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
          {files.length > 0 ? <small>{files.map((file) => file.name).join(", ")}</small> : null}
          <label htmlFor="scheduled-profile-workflow-target">Run in</label>
          <select id="scheduled-profile-workflow-target" value={workspaceTarget} onChange={(event) => setWorkspaceTarget(event.target.value as "local" | "hosted")}>
            <option value="local">Desktop local workspace</option>
            <option value="hosted">Hosted Work</option>
          </select>
          {workflow.invocation.kind === "agent_action" ? (
            <>
              <label htmlFor="scheduled-profile-workflow-input">Input JSON</label>
              <textarea id="scheduled-profile-workflow-input" onChange={(event) => setInputText(event.target.value)} value={inputText} />
            </>
          ) : null}
          {error ? <p className="scheduled-detail-error" role="alert">{error}</p> : null}
          <div className="scheduled-detail-actions">
            <button disabled={pending} type="submit"><RotateCcw size={15} /><span>{pending ? "Starting…" : "Run now"}</span></button>
          </div>
        </form>
      </DetailSection>
    </ScheduleDetailPanel>
  );
}
