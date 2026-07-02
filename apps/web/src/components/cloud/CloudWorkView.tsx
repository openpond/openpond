import { useMemo, useRef, useState } from "react";
import type {
  CloudProject,
  CloudWorkItem,
  CloudWorkItemDetail,
  CloudWorkItemMessage,
  CreatePipelineRequest,
  CreatePipelineSnapshot,
} from "@openpond/contracts";
import { createPipelineActionShapeFromMetadata } from "@openpond/contracts";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  FileText,
  Play,
  Plus,
  Search,
  Settings,
  Square,
  X,
} from "../icons";
import { DropdownSelect } from "../DropdownSelect";
import {
  modelOptionsForProvider,
  normalizeChatModel,
  type DropdownOption,
} from "../../lib/app-models";
import { relativeAge } from "../../lib/chat-messages";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import { insertVoiceTranscript } from "../../lib/voice-text";
import { VoiceInputButton } from "../voice/VoiceInputButton";
import {
  createPipelineAgentIdFromObjective,
  createPipelineSourceRootPathForAgent,
} from "../../lib/create-pipeline-request";

type CloudTaskTab = "tasks" | "reviews" | "archive";

type CloudWorkViewProps = {
  projects: CloudProject[];
  workItems: CloudWorkItem[];
  selectedWorkItem: CloudWorkItem | null;
  detail: CloudWorkItemDetail | null;
  loading: boolean;
  actionBusy: boolean;
  connection: ClientConnection | null;
  error: string | null;
  model: string;
  showToast: ShowAppToast;
  onBack: () => void;
  onModelChange: (model: string) => void;
  onSetupCloudProject: (projectId: string) => void;
  onCreateWork: (input: { projectId: string; prompt: string }) => Promise<unknown>;
  onSelectWorkItem: (workItem: CloudWorkItem) => void;
  onSendMessage: (message: string) => Promise<void>;
  onHandleBackground: (message: string | null) => Promise<void>;
  onCancelCreatePlan: () => Promise<void>;
  onCancelTask: () => Promise<void>;
  onShowFiles?: () => void;
};

function taskMatchesTab(workItem: CloudWorkItem, tab: CloudTaskTab): boolean {
  if (tab === "archive") return Boolean(workItem.archivedAt);
  if (tab === "reviews") return workItem.status === "needs_review";
  return !workItem.archivedAt;
}

function statusLabel(status: CloudWorkItem["status"]): string {
  if (status === "backlog") return "Task";
  if (status === "needs_review") return "Review";
  return status.replace(/_/g, " ");
}

function projectLabel(projectsById: Map<string, CloudProject>, projectId: string): string {
  const project = projectsById.get(projectId);
  return project?.organizationName
    ? `${project.organizationName} / ${project.name}`
    : (project?.name ?? "Cloud Project");
}

function firstMessage(messages: CloudWorkItemMessage[]): CloudWorkItemMessage | null {
  const visibleMessages = messages.filter((message) => !isHiddenCreatePipelineMessage(message));
  return visibleMessages.find((message) => message.role === "user") ?? visibleMessages[0] ?? null;
}

function isHiddenCreatePipelineMessage(message: CloudWorkItemMessage): boolean {
  return (
    message.metadata.source === "openpond_app_cloud_create_pipeline_link" ||
    message.metadata.hidden === true
  );
}

function requestAdapterLabel(request: CreatePipelineRequest): string {
  if (request.adapter.kind === "local") return "Local profile";
  if (request.adapter.kind === "promote_local_to_hosted") return "Local to hosted";
  return "Hosted profile";
}

function planChecks(snapshot: CreatePipelineSnapshot | null): Array<{ name: string; command: string }> {
  return snapshot?.plan?.checks?.length
    ? snapshot.plan.checks.map((check) => ({ name: check.name, command: check.command }))
    : [
        { name: "inspect", command: "bun run agent:inspect" },
        { name: "build", command: "bun run build" },
        { name: "validate", command: "bun run agent:validate" },
        { name: "eval", command: "bun run agent:eval" },
      ];
}

function planRequirements(snapshot: CreatePipelineSnapshot | null): Array<{ name: string; detail: string }> {
  return snapshot?.plan?.requirements?.map((requirement) => ({
    name: requirement.name,
    detail: [requirement.kind.replace(/_/g, " "), requirement.status, requirement.detail]
      .filter(Boolean)
      .join(" / "),
  })) ?? [];
}

function workflowEvidence(snapshot: CreatePipelineSnapshot | null): Array<{ name: string; detail: string }> {
  const capture = snapshot?.workflowCapture;
  if (!capture) return [];
  return [
    { name: "Actions", values: capture.profileActions },
    { name: "Providers", values: capture.externalProviders },
    { name: "Side effects", values: capture.sideEffects },
    { name: "Files", values: capture.files },
    { name: "Artifacts", values: capture.outputArtifacts },
    { name: "Traces", values: capture.traceRefs },
    { name: "Channels", values: capture.channelTargets },
  ].flatMap(({ name, values }) =>
    values.length ? [{ name, detail: values.join(", ") }] : [],
  );
}

function sourcePlan(request: CreatePipelineRequest, snapshot: CreatePipelineSnapshot | null) {
  if (snapshot?.plan?.sourcePlan?.length) return snapshot.plan.sourcePlan;
  const operation = request.operation === "edit" ? "update" : "create";
  const agentId =
    request.targetAgent.agentId ?? createPipelineAgentIdFromObjective(request.objective);
  return [
    {
      path: createPipelineSourceRootPathForAgent(agentId),
      operation,
      reason: request.objective,
    },
    {
      path: "settings/profile.yaml",
      operation: "update",
      reason: "Expose the default chat action through the hosted profile catalog.",
    },
  ];
}

function CloudCreatePlanReview({
  request,
  snapshot,
  actionBusy,
  onApprove,
  onEdit,
  onCancel,
}: {
  request: CreatePipelineRequest;
  snapshot: CreatePipelineSnapshot | null;
  actionBusy: boolean;
  onApprove: () => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const state = snapshot?.state ?? "awaiting_plan_approval";
  const plan = snapshot?.plan ?? null;
  const checks = planChecks(snapshot);
  const requirements = planRequirements(snapshot);
  const evidence = workflowEvidence(snapshot);
  const files = sourcePlan(request, snapshot);
  const actionShape = createPipelineActionShapeFromMetadata(plan?.metadata);
  const targetProject = request.scope.targetProject?.name ?? request.scope.targetProject?.id ?? "Profile source";
  const canApprove =
    Boolean(plan) &&
    state === "awaiting_plan_approval" &&
    (plan?.status === "draft" || plan?.status === "pending_approval");
  const canEdit =
    (state === "planning" || state === "awaiting_plan_approval") &&
    (plan?.status === "draft" || plan?.status === "pending_approval");

  return (
    <article className="cloud-create-plan-review">
      <div className="cloud-create-plan-heading">
        <FileText size={16} />
        <div>
          <span>Agent plan review</span>
          <small>{request.operation} / {requestAdapterLabel(request)} / {state.replace(/_/g, " ")}</small>
        </div>
      </div>
      <div className="cloud-create-plan-copy">
        <section>
          <span>Objective</span>
          <p>{request.objective}</p>
        </section>
        <section>
          <span>Target</span>
          <p>{targetProject}</p>
        </section>
        {plan?.capturedContextSummary ? (
          <section>
            <span>Captured context</span>
            <p>{plan.capturedContextSummary}</p>
          </section>
        ) : request.context.targetRepoAssumptions.length ? (
          <section>
            <span>Captured context</span>
            <p>{request.context.targetRepoAssumptions.join("; ")}</p>
          </section>
        ) : null}
        {request.context.attachments.length ? (
          <section>
            <span>Inputs</span>
            <p>{request.context.attachments.map((attachment) => attachment.name).join(", ")}</p>
          </section>
        ) : null}
        {request.context.apps.length ? (
          <section>
            <span>Apps</span>
            <p>{request.context.apps.map((app) => app.name).join(", ")}</p>
          </section>
        ) : null}
        {request.context.tools.length ? (
          <section>
            <span>Tools</span>
            <p>{request.context.tools.map((tool) => tool.name).join(", ")}</p>
          </section>
        ) : null}
        {actionShape ? (
          <section>
            <span>Action shape</span>
            <p>{actionShape.label}: {actionShape.detail}</p>
          </section>
        ) : null}
      </div>
      <div className="cloud-create-plan-grid">
        {actionShape ? (
          <section>
            <span>Actions</span>
            <ul>
              <li>
                <code>{actionShape.defaultActionKey ?? "chat"}</code>
                <small>{actionShape.label}</small>
              </li>
              {actionShape.directActionHint ? (
                <li>
                  <code>direct action</code>
                  <small>{actionShape.directActionHint}</small>
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}
        <section>
          <span>Source plan</span>
          <ul>
            {files.map((file) => (
              <li key={`${file.operation}:${file.path}`}>
                <code>{file.path}</code>
                <small>{file.operation}</small>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <span>Checks</span>
          <ul>
            {checks.map((check) => (
              <li key={`${check.name}:${check.command}`}>
                <code>{check.name}</code>
                <small>{check.command}</small>
              </li>
            ))}
          </ul>
        </section>
        {requirements.length ? (
          <section>
            <span>Requirements</span>
            <ul>
              {requirements.map((requirement) => (
                <li key={`${requirement.name}:${requirement.detail}`}>
                  <code>{requirement.name}</code>
                  <small>{requirement.detail}</small>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {evidence.length ? (
          <section>
            <span>Workflow evidence</span>
            <ul>
              {evidence.map((item) => (
                <li key={`${item.name}:${item.detail}`}>
                  <code>{item.name}</code>
                  <small>{item.detail}</small>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <div className="cloud-create-plan-actions">
        <button type="button" onClick={onApprove} disabled={actionBusy || !canApprove}>
          <Check size={14} />
          <span>Confirm plan</span>
        </button>
        <button type="button" onClick={onEdit} disabled={actionBusy || !canEdit}>
          <FileText size={14} />
          <span>Edit plan</span>
        </button>
        <button type="button" onClick={onCancel} disabled={actionBusy}>
          <X size={14} />
          <span>Cancel</span>
        </button>
      </div>
    </article>
  );
}

export function CloudWorkView({
  projects,
  workItems,
  selectedWorkItem,
  detail,
  loading,
  actionBusy,
  connection,
  error,
  model,
  showToast,
  onBack,
  onModelChange,
  onSetupCloudProject,
  onCreateWork,
  onSelectWorkItem,
  onSendMessage,
  onHandleBackground,
  onCancelCreatePlan,
  onCancelTask,
  onShowFiles,
}: CloudWorkViewProps) {
  const [homePrompt, setHomePrompt] = useState("");
  const [threadPrompt, setThreadPrompt] = useState("");
  const homeTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const threadTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [homeCursorIndex, setHomeCursorIndex] = useState(0);
  const [threadCursorIndex, setThreadCursorIndex] = useState(0);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [threadOptionsOpen, setThreadOptionsOpen] = useState(false);
  const [tab, setTab] = useState<CloudTaskTab>("tasks");
  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState(() => projects[0]?.id ?? "");
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const activeProjectId = projectsById.has(projectId) ? projectId : (projects[0]?.id ?? "");
  const activeModel = normalizeChatModel("openpond", model);
  const projectOptions = useMemo<DropdownOption[]>(
    () =>
      projects.length
        ? projects.map((project) => ({
            value: project.id,
            label: project.organizationName
              ? `${project.organizationName} / ${project.name}`
              : project.name,
            shortLabel: project.name,
            description: project.sourceLabel ?? project.defaultBranch ?? undefined,
          }))
        : [{ value: "", label: "No Cloud Project" }],
    [projects],
  );
  const filteredWorkItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return workItems.filter((workItem) => {
      if (!taskMatchesTab(workItem, tab)) return false;
      if (!query) return true;
      return workItem.title.toLowerCase().includes(query);
    });
  }, [search, tab, workItems]);

  async function submitHome() {
    const prompt = homePrompt.trim();
    if (!prompt || !activeProjectId || actionBusy) return;
    await onCreateWork({ projectId: activeProjectId, prompt });
    setHomePrompt("");
    setOptionsOpen(false);
  }

  async function submitThreadMessage() {
    const message = threadPrompt.trim();
    if (!message || actionBusy) return;
    await onSendMessage(message);
    setThreadPrompt("");
  }

  async function handleThreadBackground() {
    const message = threadPrompt.trim();
    await onHandleBackground(message || null);
    setThreadPrompt("");
    setThreadOptionsOpen(false);
  }

  function updateHomeCursor(textarea: HTMLTextAreaElement) {
    setHomeCursorIndex(textarea.selectionStart ?? textarea.value.length);
  }

  function updateThreadCursor(textarea: HTMLTextAreaElement) {
    setThreadCursorIndex(textarea.selectionStart ?? textarea.value.length);
  }

  function insertHomeDictation(text: string) {
    const textarea = homeTextareaRef.current;
    const next = insertVoiceTranscript(homePrompt, text, textarea?.selectionStart ?? homeCursorIndex);
    setHomePrompt(next.value);
    setHomeCursorIndex(next.cursorIndex);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(next.cursorIndex, next.cursorIndex);
    });
  }

  function insertThreadDictation(text: string) {
    const textarea = threadTextareaRef.current;
    const next = insertVoiceTranscript(threadPrompt, text, textarea?.selectionStart ?? threadCursorIndex);
    setThreadPrompt(next.value);
    setThreadCursorIndex(next.cursorIndex);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(next.cursorIndex, next.cursorIndex);
    });
  }

  function startPlanEdit() {
    setThreadPrompt((current) => current || "Revise plan: ");
    window.requestAnimationFrame(() => {
      const textarea = threadTextareaRef.current;
      const cursor = textarea?.value.length ?? 0;
      textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
      setThreadCursorIndex(cursor);
    });
  }

  if (selectedWorkItem) {
    const messages = detail?.messages ?? [];
    const activity = detail?.activity ?? [];
    const createPipelineRequest =
      detail?.createPipelineRequest ??
      selectedWorkItem.createPipelineRequest ??
      null;
    const createPipeline =
      detail?.createPipeline ??
      selectedWorkItem.createPipeline ??
      null;
    const initialMessage = firstMessage(messages);
    const initialMessageBody = initialMessage?.body ?? selectedWorkItem.title;
    const project = projectsById.get(selectedWorkItem.projectId) ?? null;
    const taskRunning =
      selectedWorkItem.status === "queued" ||
      selectedWorkItem.status === "running";
    return (
      <section className="cloud-work-view thread">
        <div className="cloud-thread-body">
          <div className="cloud-thread-timeline">
            <div className="cloud-thread-inline-nav">
              <button type="button" onClick={onBack}>
                <ArrowLeft size={15} />
                <span>All tasks</span>
              </button>
              <span>{project?.name ?? "Cloud Project"}</span>
              {selectedWorkItem.sourceRef ? <span>{selectedWorkItem.sourceRef}</span> : null}
              {onShowFiles ? (
                <button type="button" onClick={onShowFiles}>
                  <span>Files</span>
                </button>
              ) : null}
            </div>
            {initialMessageBody && (
              <article className="cloud-message user">
                <p>{initialMessageBody}</p>
              </article>
            )}
            <div className="cloud-worked-line">
              <span>{statusLabel(selectedWorkItem.status)}</span>
              <span>{relativeAge(selectedWorkItem.updatedAt)}</span>
              {taskRunning && (
                <button type="button" onClick={() => void onCancelTask()} disabled={actionBusy}>
                  <Square size={12} />
                  <span>Stop task</span>
                </button>
              )}
            </div>
            {createPipelineRequest ? (
              <CloudCreatePlanReview
                request={createPipelineRequest}
                snapshot={createPipeline}
                actionBusy={actionBusy}
                onApprove={() => void onHandleBackground(null)}
                onEdit={startPlanEdit}
                onCancel={() => void onCancelCreatePlan()}
              />
            ) : null}
            {messages
              .filter((message) => message.id !== initialMessage?.id)
              .filter((message) => !isHiddenCreatePipelineMessage(message))
              .map((message) => (
                <article key={message.id} className={`cloud-message ${message.role}`}>
                  <p>{message.body}</p>
                </article>
              ))}
            {activity.map((item) => (
              <article key={item.id} className="cloud-activity">
                <span>{item.kind.replace(/_/g, " ")}</span>
                <p>{item.summary}</p>
              </article>
            ))}
            {!loading && messages.length === 0 && activity.length === 0 && !initialMessageBody && (
              <p className="cloud-muted">No messages yet.</p>
            )}
          </div>
        </div>

        <div className="cloud-thread-composer">
          <button
            type="button"
            className={`cloud-composer-plus ${threadOptionsOpen ? "active" : ""}`}
            onClick={() => setThreadOptionsOpen((open) => !open)}
            title="Cloud task options"
          >
            <Plus size={18} />
          </button>
          {threadOptionsOpen && (
            <div className="cloud-composer-options thread-options">
              <button type="button" onClick={() => void handleThreadBackground()} disabled={actionBusy}>
                <Play size={14} />
                <span>Handle in background</span>
              </button>
              {taskRunning && (
                <button type="button" onClick={() => void onCancelTask()} disabled={actionBusy}>
                  <Square size={14} />
                  <span>Stop task</span>
                </button>
              )}
            </div>
          )}
          <textarea
            ref={threadTextareaRef}
            value={threadPrompt}
            rows={1}
            placeholder="Request changes or ask a question"
            onChange={(event) => {
              setThreadPrompt(event.target.value);
              updateThreadCursor(event.currentTarget);
            }}
            onClick={(event) => updateThreadCursor(event.currentTarget)}
            onSelect={(event) => updateThreadCursor(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitThreadMessage();
              }
            }}
          />
          <VoiceInputButton
            buttonClassName="cloud-composer-mic-button"
            connection={connection}
            disabled={actionBusy}
            iconSize={17}
            wrapperClassName="cloud-composer-mic"
            showToast={showToast}
            onTranscript={insertThreadDictation}
          />
          <button
            type="button"
            className="cloud-composer-submit"
            disabled={!threadPrompt.trim() || actionBusy}
            onClick={() => void submitThreadMessage()}
            title="Send"
          >
            <ArrowUp size={17} />
          </button>
        </div>
        {error && <div className="cloud-error">{error}</div>}
      </section>
    );
  }

  return (
    <section className="cloud-work-view home">
      <div className="cloud-home-shell">
        <h1>What should we change next?</h1>
        <div className="cloud-home-composer">
          <textarea
            ref={homeTextareaRef}
            value={homePrompt}
            rows={2}
            placeholder="Describe a task"
            onChange={(event) => {
              setHomePrompt(event.target.value);
              updateHomeCursor(event.currentTarget);
            }}
            onClick={(event) => updateHomeCursor(event.currentTarget)}
            onSelect={(event) => updateHomeCursor(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitHome();
              }
            }}
          />
          <div className="cloud-home-composer-actions">
            <button
              type="button"
              className={`cloud-composer-plus ${optionsOpen ? "active" : ""}`}
              onClick={() => setOptionsOpen((open) => !open)}
              title="Cloud task options"
            >
              <Plus size={18} />
            </button>
            <div className="cloud-composer-selects">
              <DropdownSelect
                compact
                className="cloud-project-select"
                disabled={actionBusy || projects.length === 0}
                label="Cloud Project"
                options={projectOptions}
                placement="top"
                value={activeProjectId}
                onChange={setProjectId}
              />
              <DropdownSelect
                compact
                className="cloud-model-select"
                disabled={actionBusy}
                label="Model"
                options={modelOptionsForProvider("openpond")}
                placement="top"
                value={activeModel}
                onChange={onModelChange}
              />
            </div>
            <VoiceInputButton
              buttonClassName="cloud-composer-mic-button"
              connection={connection}
              disabled={actionBusy}
              iconSize={17}
              wrapperClassName="cloud-composer-mic"
              showToast={showToast}
              onTranscript={insertHomeDictation}
            />
            <button
              type="button"
              className="cloud-composer-submit"
              disabled={!homePrompt.trim() || !activeProjectId || actionBusy}
              onClick={() => void submitHome()}
              title="Handle in background"
            >
              <ArrowUp size={17} />
            </button>
          </div>
          {optionsOpen && (
            <div className="cloud-composer-options">
              <button
                type="button"
                onClick={() => setOptionsOpen(false)}
                disabled={actionBusy}
              >
                <Plus size={14} />
                <span>New task</span>
              </button>
              <button
                type="button"
                onClick={() => onSetupCloudProject(activeProjectId)}
                disabled={!activeProjectId || actionBusy}
              >
                <Settings size={14} />
                <span>Create environment</span>
              </button>
            </div>
          )}
        </div>

        <div className="cloud-task-list-toolbar">
          <div className="cloud-task-tabs" role="tablist" aria-label="Cloud tasks">
            <button type="button" className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}>
              Tasks
            </button>
            <button type="button" className={tab === "reviews" ? "active" : ""} onClick={() => setTab("reviews")}>
              Code reviews
            </button>
            <button type="button" className={tab === "archive" ? "active" : ""} onClick={() => setTab("archive")}>
              Archive
            </button>
          </div>
          <label className="cloud-task-search">
            <Search size={17} />
            <input
              value={search}
              placeholder="Search"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>

        <div className="cloud-task-list">
          {filteredWorkItems.map((workItem) => (
            <button
              key={workItem.id}
              type="button"
              className="cloud-task-row"
              onClick={() => onSelectWorkItem(workItem)}
            >
              <span>{workItem.title}</span>
              <small>
                {relativeAge(workItem.updatedAt)} · {projectLabel(projectsById, workItem.projectId)}
              </small>
            </button>
          ))}
          {!loading && filteredWorkItems.length === 0 && (
            <p className="cloud-empty">
              {projects.length ? "No tasks yet" : "Create or link a Cloud Project before starting a task"}
            </p>
          )}
          {loading && <p className="cloud-empty">Loading tasks...</p>}
        </div>
        {error && <div className="cloud-error">{error}</div>}
      </div>
    </section>
  );
}
