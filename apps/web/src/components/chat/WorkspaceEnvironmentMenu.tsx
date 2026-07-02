import { useEffect, useMemo, useRef, useState } from "react";
import type {
  LocalProject,
  BootstrapPayload,
  OpenPondApp,
  WorkspaceDiffSummary,
  WorkspaceKind,
  WorkspaceState,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from "@openpond/contracts";
import { OPENPOND_MANIFEST_FILE_NAME, sandboxTemplateExecutableEntries } from "@openpond/contracts";
import {
  Boxes,
  Check,
  ChevronDown,
  GitBranch,
  Info,
  Monitor,
  PanelRight,
  Search,
} from "../icons";
import { api, type ClientConnection } from "../../api";
import { normalizeOpenPondOrganization } from "../../lib/cloud-project-utils";
import { implicitOrganization, resolveProjectAgentSetup } from "../../lib/project-agent-setup";
import type { OpenPondOrganization } from "../../lib/organization-types";
import type { SandboxAgent, SandboxProject, SandboxRecord } from "../../lib/sandbox-types";
import {
  finishSandboxPreviewPopup,
  openSandboxPreviewPopup,
  previewUrlFromWorkspaceToolResult,
  SandboxCreateDialog,
  type SandboxCreateDialogInput,
} from "../app-shell/SandboxCreateDialog";
import { SandboxRunActionDialog, type SandboxRunActionDialogInput } from "../app-shell/SandboxRunActionDialog";
import type { CommitNextStep } from "../workspace/WorkspaceGitDialogs";
import {
  workspaceEnvironmentActionItems,
  type EnvironmentActionItem,
} from "./workspace-environment-actions";
import {
  AgentConfigDialog,
  ConfirmAgentSetupDialog,
  ConnectProjectDialog,
  CreateAgentDialog,
  type AgentConfigDialogInput,
  type ConnectProjectDialogInput,
  type CreateAgentDialogInput,
  type ProjectAgentDialogKind,
} from "./AgentSetupDialogs";
import {
  agentSetupStatusLabel,
  commandWithReplayParams,
  errorMessage,
  fileToBase64,
  parseProjectSourceValue,
  repoUrlFromApp,
  repoUrlFromPublishResult,
  sandboxIdFromWorkspaceToolResult,
  sandboxNameFromRecord,
  sandboxScheduleCreateArgs,
  sandboxUploadPath,
  starterManifestPreview,
  workspaceSourceLabel,
} from "./workspace-environment-helpers";

export function WorkspaceEnvironmentMenu({
  mode,
  busy,
  workspaceState,
  workspaceKind,
  selectedApp,
  selectedProject,
  workspaceBusy,
  defaultTeamId,
  workspaceDiff,
  managedWorkspace,
  showDiffControls,
  diffPanelOpen,
  onToggleDiffPanel,
  onRunTerminalCommand,
  onWorkspaceToolAction,
  onOpenCommitDialog,
  onWorkspaceBranchChange,
  onWorkspaceBranchCreate,
  connection,
  onBootstrap,
  onOpenSandboxWorkspace,
}: {
  mode: "dock" | "start" | "topbar";
  busy: boolean;
  workspaceState?: WorkspaceState | null;
  workspaceKind?: WorkspaceKind | null;
  selectedApp?: OpenPondApp | null;
  selectedProject?: LocalProject | null;
  workspaceBusy?: boolean;
  defaultTeamId?: string | null;
  workspaceDiff?: WorkspaceDiffSummary | null;
  managedWorkspace?: boolean;
  showDiffControls?: boolean;
  diffPanelOpen?: boolean;
  onToggleDiffPanel?: () => void;
  onRunTerminalCommand?: (command: string) => void;
  onWorkspaceToolAction?: (
    action: WorkspaceToolRequest["action"],
    args?: Record<string, unknown>,
  ) => Promise<WorkspaceToolResult | null>;
  onOpenCommitDialog?: (nextStep?: CommitNextStep) => void;
  onWorkspaceBranchChange?: (branch: string) => void;
  onWorkspaceBranchCreate?: () => void;
  connection?: ClientConnection | null;
  onBootstrap?: (payload: BootstrapPayload) => void;
  onOpenSandboxWorkspace?: (input: { sandboxId: string; name: string | null }) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [sandboxCreateDialogOpen, setSandboxCreateDialogOpen] = useState(false);
  const [sandboxRunActionDialogOpen, setSandboxRunActionDialogOpen] = useState(false);
  const [agentSetupDialog, setAgentSetupDialog] = useState<ProjectAgentDialogKind | null>(null);
  const [agentSetupBusy, setAgentSetupBusy] = useState(false);
  const [agentSetupLoading, setAgentSetupLoading] = useState(false);
  const [agentSetupError, setAgentSetupError] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<OpenPondOrganization[]>([]);
  const [sandboxProjects, setSandboxProjects] = useState<SandboxProject[]>([]);
  const [sandboxAgents, setSandboxAgents] = useState<SandboxAgent[]>([]);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const branchSearchRef = useRef<HTMLInputElement | null>(null);
  const workspaceReady = Boolean(workspaceState?.initialized);
  const workspaceBusyValue = Boolean(workspaceBusy);
  const managed = Boolean(managedWorkspace);
  const additions = workspaceDiff?.additions ?? 0;
  const deletions = workspaceDiff?.deletions ?? 0;
  const filesChanged = workspaceDiff?.filesChanged ?? workspaceState?.changedFilesCount ?? 0;
  const hasDiffs = filesChanged > 0;
  const isProjectWorkspace = workspaceKind === "local_project" || Boolean(selectedProject);
  const isSandboxWorkspace = workspaceKind === "sandbox" || workspaceKind === "sandbox_template";
  const gitWorkspace = workspaceState?.source !== "local_folder";
  const canInitGit = isProjectWorkspace && workspaceState?.source === "local_folder";
  const hasRemote = Boolean(workspaceState?.remoteUrl);
  const projectRemoteUrl = workspaceState?.remoteUrl?.trim() ?? "";
  const selectedAppRepoUrl = repoUrlFromApp(selectedApp ?? null);
  const projectSandboxTemplate = Boolean(selectedProject?.sandboxTemplate?.detected);
  const projectSandboxTemplateValid = Boolean(
    selectedProject?.sandboxTemplate?.valid &&
      selectedProject.sandboxTemplate.normalizedManifest,
  );
  const projectSandboxTemplateManifest = selectedProject?.sandboxTemplate?.normalizedManifest ?? null;
  const sandboxTemplateExecutables = projectSandboxTemplateManifest
    ? sandboxTemplateExecutableEntries(projectSandboxTemplateManifest)
    : [];
  const sandboxTemplateActionTargets = sandboxTemplateExecutables.filter((entry) => entry.kind === "action");
  const sandboxTemplateServiceTargets = sandboxTemplateExecutables.filter((entry) => entry.kind === "service");
  const projectHasStoredOpenPondLink = Boolean(selectedProject?.linkedOpenPondApp?.appId);
  const agentSetup = resolveProjectAgentSetup({
    localProject: selectedProject,
    organizations,
    projects: sandboxProjects,
    agents: sandboxAgents,
    defaultTeamId,
  });
  const implicitTeam = implicitOrganization(organizations, defaultTeamId);
  const canPublishProject =
    isProjectWorkspace && projectSandboxTemplate && !projectHasStoredOpenPondLink;
  const canCreateSandboxProject =
    isProjectWorkspace &&
    projectSandboxTemplate &&
    projectSandboxTemplateValid &&
    (canPublishProject || Boolean(projectRemoteUrl));
  const branchNames = workspaceState
    ? Array.from(
        new Set(
          [workspaceState.currentBranch, ...workspaceState.branches].filter((branch): branch is string => Boolean(branch)),
        ),
      )
    : [];
  const currentBranch = workspaceState?.initialized
    ? workspaceState.currentBranch ?? branchNames[0] ?? "No branch"
    : "Not synced";
  const sourceLabel = workspaceSourceLabel(workspaceState);
  const filteredBranches = useMemo(() => {
    const needle = branchQuery.trim().toLowerCase();
    if (!needle) return branchNames;
    return branchNames.filter((branch) => branch.toLowerCase().includes(needle));
  }, [branchNames, branchQuery]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open && branchOpen) branchSearchRef.current?.focus();
  }, [branchOpen, open]);

  useEffect(() => {
    if (!connection || !open || !isProjectWorkspace) return;
    let cancelled = false;
    setAgentSetupLoading(true);
    setAgentSetupError(null);
    api
      .organizations(connection)
      .then(async (payload) => {
        if (cancelled) return;
        const organizations = payload.organizations
          .map(normalizeOpenPondOrganization)
          .filter((organization): organization is OpenPondOrganization => Boolean(organization))
          .filter((organization) => organization.status === "active");
        setOrganizations(organizations);
        const organization = implicitOrganization(organizations, defaultTeamId);
        if (!organization) return;
        const [projectPayload, agentPayload] = await Promise.all([
          api.listSandboxProjects(connection, { teamId: organization.teamId }),
          api.listSandboxAgents(connection, { teamId: organization.teamId }),
        ]);
        if (cancelled) return;
        setSandboxProjects(projectPayload.projects);
        setSandboxAgents(agentPayload.agents);
      })
      .catch((caught) => {
        if (!cancelled) setAgentSetupError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setAgentSetupLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, defaultTeamId, isProjectWorkspace, open]);

  async function ensureSandboxTemplateSource(commitMessage: string): Promise<boolean> {
    if (!onWorkspaceToolAction) return false;
    if (!projectRemoteUrl && canPublishProject) {
      const publishResult = await onWorkspaceToolAction("publish_openpond_repo", {
        replaceOrigin: false,
        ...(workspaceState?.dirty ? { commitDirty: true, commitMessage } : {}),
      });
      return Boolean(publishResult?.ok);
    }

    if (!gitWorkspace || !hasRemote) return Boolean(projectRemoteUrl);

    if (workspaceState?.dirty) {
      const commitResult = await onWorkspaceToolAction("git_commit", {
        message: commitMessage,
        includeUnstaged: true,
      });
      if (!commitResult?.ok) return false;
    }

    if (workspaceState?.dirty || (workspaceState?.ahead ?? 0) > 0 || !workspaceState?.upstreamBranch) {
      const pushResult = await onWorkspaceToolAction("git_push", { runChecks: false });
      if (!pushResult?.ok) return false;
    }

    return true;
  }

  async function createSandboxFromProject(input: SandboxCreateDialogInput) {
    if (!onWorkspaceToolAction) return;
    const previewWindow = input.openPreview ? openSandboxPreviewPopup() : null;
    let repoUrl = input.repoUrl || projectRemoteUrl;

    if (canPublishProject) {
      if (hasRemote && !window.confirm("Replace the current origin remote with a new OpenPond repo before starting the sandbox?")) {
        finishSandboxPreviewPopup(previewWindow, null);
        return;
      }
      const publishResult = await onWorkspaceToolAction("publish_openpond_repo", {
        replaceOrigin: hasRemote,
        ...(workspaceState?.dirty ? { commitDirty: true, commitMessage: input.commitMessage } : {}),
      });
      if (!publishResult?.ok) {
        finishSandboxPreviewPopup(previewWindow, null);
        return;
      }
      repoUrl = repoUrlFromPublishResult(publishResult) ?? repoUrl;
    } else if (gitWorkspace && hasRemote) {
      if (workspaceState?.dirty) {
        const commitResult = await onWorkspaceToolAction("git_commit", {
          message: input.commitMessage,
          includeUnstaged: true,
          runChecks: false,
        });
        if (!commitResult?.ok) {
          finishSandboxPreviewPopup(previewWindow, null);
          return;
        }
      }
      const pushResult = await onWorkspaceToolAction("git_push", { runChecks: false });
      if (!pushResult?.ok) {
        finishSandboxPreviewPopup(previewWindow, null);
        return;
      }
    }

    if (!repoUrl) {
      finishSandboxPreviewPopup(previewWindow, null);
      return;
    }

    const result = await onWorkspaceToolAction("sandbox_create", {
      repo: repoUrl,
      visibility: "team",
      resources: input.resources,
      budget: { maxUsd: input.budgetUsd },
      quotas: { maxSpendUsd: input.budgetUsd },
      ...(input.env.length > 0 ? { env: input.env } : {}),
      ...(input.volumes.length > 0 ? { volumes: input.volumes } : {}),
      metadata: {
        source: "openpond-app-local-sandbox-template-start",
        ...(input.entrypointName ? { entrypointName: input.entrypointName } : {}),
        ...(selectedProject?.id ? { localProjectId: selectedProject.id } : {}),
        ...(selectedProject?.name ? { projectName: selectedProject.name } : {}),
        ...(projectSandboxTemplateManifest
          ? {
              templateName: projectSandboxTemplateManifest.name,
              templateVersion: projectSandboxTemplateManifest.version,
              templateUseCase: projectSandboxTemplateManifest.useCase,
              templateTargets: sandboxTemplateExecutables.map((target) => ({
                name: target.name,
                kind: target.kind,
              })),
            }
          : {}),
      },
      ...(input.openPreview && input.previewPort
        ? {
            previewPort: input.previewPort,
            previewLabel: input.previewLabel,
            previewAccess: input.previewAccess,
            previewAutoStart: true,
          }
        : {}),
    });
    const previewUrl = previewUrlFromWorkspaceToolResult(result);
    if (input.openPreview) finishSandboxPreviewPopup(previewWindow, previewUrl);
    if (!result?.ok) return;
    const sandboxId = sandboxIdFromWorkspaceToolResult(result);

    for (const setupCommand of projectSandboxTemplateManifest?.setup.commands ?? []) {
      const setupResult = await onWorkspaceToolAction("sandbox_exec", {
        command: setupCommand,
        timeoutSeconds: 900,
      });
      if (!setupResult?.ok) return;
    }

    const uploadedParams: Record<string, unknown> = {};
    for (const upload of input.uploads) {
      const uploadedPaths: string[] = [];
      for (const file of upload.files) {
        const path = sandboxUploadPath(upload.targetPath, file.name);
        const contentsBase64 = await fileToBase64(file);
        const uploadResult = await onWorkspaceToolAction("sandbox_upload_file", {
          path,
          contentsBase64,
        });
        if (!uploadResult?.ok) return;
        uploadedPaths.push(path);
      }
      uploadedParams[upload.inputName] = upload.multiple ? uploadedPaths : uploadedPaths[0] ?? "";
    }

    const command = commandWithReplayParams(input.command, {
      ...input.params,
      ...uploadedParams,
    });
    const execResult = await onWorkspaceToolAction("sandbox_exec", {
      command,
      timeoutSeconds: input.timeoutSeconds ?? 900,
    });
    if (!execResult?.ok) return;
    if (sandboxId) {
      for (const schedule of input.schedules) {
        const scheduleResult = await onWorkspaceToolAction(
          "sandbox_schedule_create",
          sandboxScheduleCreateArgs(schedule, sandboxId),
        );
        if (!scheduleResult?.ok) return;
      }
    }
    setSandboxCreateDialogOpen(false);
  }

  async function runSandboxTemplateAction(input: SandboxRunActionDialogInput) {
    if (!onWorkspaceToolAction) return;
    if (input.mode === "sandbox") {
      const sourceReady = await ensureSandboxTemplateSource(`Run ${input.target} in sandbox`);
      if (!sourceReady) return;
    }

    const uploadedParams: Record<string, unknown> = {};
    const uploads: Array<{ path: string; contentsBase64: string }> = [];
    for (const upload of input.uploads) {
      const uploadedPaths: string[] = [];
      for (const file of upload.files) {
        const path = sandboxUploadPath(upload.targetPath, file.name);
        const contentsBase64 = await fileToBase64(file);
        uploads.push({ path, contentsBase64 });
        uploadedPaths.push(path);
      }
      uploadedParams[upload.inputName] = upload.multiple ? uploadedPaths : uploadedPaths[0] ?? "";
    }
    setSandboxRunActionDialogOpen(false);
    await onWorkspaceToolAction("run_sandbox_template", {
      mode: input.mode,
      target: input.target,
      params: {
        ...input.params,
        ...uploadedParams,
      },
      ...(input.env.length > 0 ? { env: input.env } : {}),
      ...(uploads.length > 0 ? { uploads } : {}),
    });
  }

  async function refreshAgentSetup(teamId = implicitTeam?.teamId) {
    if (!connection || !teamId) return;
    const [projectPayload, agentPayload] = await Promise.all([
      api.listSandboxProjects(connection, { teamId }),
      api.listSandboxAgents(connection, { teamId }),
    ]);
    setSandboxProjects(projectPayload.projects);
    setSandboxAgents(agentPayload.agents);
  }

  async function submitAgentConfig(input: AgentConfigDialogInput) {
    if (!onWorkspaceToolAction || !selectedProject) return;
    setAgentSetupBusy(true);
    setAgentSetupError(null);
    try {
      const result = await onWorkspaceToolAction("create_sandbox_template_scaffold", {
        manifestOnly: true,
        manifestContent: starterManifestPreview(input.name, input.preset),
        name: input.name,
        preset: input.preset,
        manifestPath: input.manifestPath,
      });
      if (!result?.ok) return;
      setAgentSetupDialog(null);
    } catch (caught) {
      setAgentSetupError(errorMessage(caught));
    } finally {
      setAgentSetupBusy(false);
    }
  }

  async function submitConnectProject(input: ConnectProjectDialogInput) {
    if (!connection || !selectedProject || !onBootstrap) return;
    const teamId = input.teamId;
    setAgentSetupBusy(true);
    setAgentSetupError(null);
    try {
      const sourceParts = parseProjectSourceValue(input.sourceType, input.sourceIdentity);
      let project = (
        await api.upsertSandboxProject(connection, {
          teamId,
          name: input.projectName,
          sourceType: input.sourceType,
          normalizedSourceIdentity: input.sourceIdentity || input.projectName,
          defaultBranch: input.defaultBranch || null,
          gitProvider: input.sourceType === "github_repo" ? "github" : null,
          gitHost: sourceParts.gitHost,
          gitOwner: sourceParts.gitOwner,
          gitRepo: sourceParts.gitRepo,
          internalRepoPath: sourceParts.internalRepoPath,
          templateRepoUrl: sourceParts.templateRepoUrl,
          sourceConfig: {
            sourceType: input.sourceType,
            sourceValue: input.sourceIdentity || input.projectName,
          },
          metadata: { source: "openpond-app-local-project-agent-setup" },
        })
      ).project;
      if (input.syncNow) {
        project = (await api.syncSandboxProject(connection, project.id, { teamId })).project;
      }
      const payload = await api.updateLocalProjectAgentSetup(connection, selectedProject.id, {
        linkedSandboxProject: {
          teamId,
          projectId: project.id,
          projectSlug: project.slug,
          projectName: project.name,
          sourceRepoUrl: input.sourceIdentity || null,
          defaultBranch: project.defaultBranch,
          manifestPath: project.sandboxManifestPath,
          manifestHash: project.sandboxManifestHash,
          syncedAt: project.sandboxManifestSyncedAt,
          linkedAt: new Date().toISOString(),
        },
      });
      onBootstrap(payload.bootstrap);
      setSandboxProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
      setAgentSetupDialog(null);
    } catch (caught) {
      setAgentSetupError(errorMessage(caught));
    } finally {
      setAgentSetupBusy(false);
    }
  }

  async function submitSyncProject() {
    if (!connection || !selectedProject || !agentSetup.project || !onBootstrap) return;
    const project = agentSetup.project;
    setAgentSetupBusy(true);
    setAgentSetupError(null);
    try {
      const synced = (await api.syncSandboxProject(connection, project.id, { teamId: project.teamId })).project;
      const payload = await api.updateLocalProjectAgentSetup(connection, selectedProject.id, {
        linkedSandboxProject: {
          teamId: synced.teamId,
          projectId: synced.id,
          projectSlug: synced.slug,
          projectName: synced.name,
          sourceRepoUrl: workspaceState?.remoteUrl ?? selectedProject.linkedSandboxProject?.sourceRepoUrl ?? null,
          defaultBranch: synced.defaultBranch,
          manifestPath: synced.sandboxManifestPath,
          manifestHash: synced.sandboxManifestHash,
          syncedAt: synced.sandboxManifestSyncedAt,
          linkedAt: selectedProject.linkedSandboxProject?.linkedAt ?? new Date().toISOString(),
        },
      });
      onBootstrap(payload.bootstrap);
      setSandboxProjects((current) => [synced, ...current.filter((candidate) => candidate.id !== synced.id)]);
      setAgentSetupDialog(null);
    } catch (caught) {
      setAgentSetupError(errorMessage(caught));
    } finally {
      setAgentSetupBusy(false);
    }
  }

  async function submitCreateAgent(input: CreateAgentDialogInput) {
    if (!connection || !selectedProject || !agentSetup.project || !onBootstrap) return;
    const project = agentSetup.project;
    setAgentSetupBusy(true);
    setAgentSetupError(null);
    try {
      const agent = (
        await api.upsertSandboxAgent(connection, {
          teamId: project.teamId,
          projectId: project.id,
          name: input.agentName,
          selectedEntrypoint: { scope: "entire_manifest", name: null },
          triggerType: "manual",
          backgroundTaskPolicy: {},
          defaultWorkflowMode: "attempt",
          defaultResourcePolicy: {},
          metadata: { source: "openpond-app-local-project-agent-setup" },
        })
      ).agent;
      let sandbox: SandboxRecord | null = null;
      let sandboxId: string | null = null;
      if (input.createTestRun) {
        const runPayload = await api.runSandboxAgent(connection, agent.id, {
          teamId: project.teamId,
          triggerType: "manual",
          metadata: { source: "openpond-app-local-project-agent-setup" },
        });
        sandbox = runPayload.sandbox ?? null;
        sandboxId = sandbox?.id ?? runPayload.run.sandboxId ?? null;
      }
      const payload = await api.updateLocalProjectAgentSetup(connection, selectedProject.id, {
        preferredSandboxAgentId: agent.id,
      });
      onBootstrap(payload.bootstrap);
      setSandboxAgents((current) => [agent, ...current.filter((candidate) => candidate.id !== agent.id)]);
      setAgentSetupDialog(null);
      if (sandboxId) {
        await onOpenSandboxWorkspace?.({
          sandboxId,
          name: sandboxNameFromRecord(sandbox) ?? `${agent.name} sandbox`,
        });
      }
    } catch (caught) {
      setAgentSetupError(errorMessage(caught));
    } finally {
      setAgentSetupBusy(false);
    }
  }

  async function submitRunAgent() {
    if (!connection || !agentSetup.agent) return;
    setAgentSetupBusy(true);
    setAgentSetupError(null);
    try {
      const runPayload = await api.runSandboxAgent(connection, agentSetup.agent.id, {
        teamId: agentSetup.agent.teamId,
        triggerType: "manual",
        metadata: { source: "openpond-app-local-project-agent-setup" },
      });
      await refreshAgentSetup(agentSetup.agent.teamId);
      setAgentSetupDialog(null);
      const sandboxId = runPayload.sandbox?.id ?? runPayload.run.sandboxId;
      if (sandboxId) {
        await onOpenSandboxWorkspace?.({
          sandboxId,
          name: sandboxNameFromRecord(runPayload.sandbox ?? null) ?? `${agentSetup.agent.name} sandbox`,
        });
      }
    } catch (caught) {
      setAgentSetupError(errorMessage(caught));
    } finally {
      setAgentSetupBusy(false);
    }
  }

  const { gitActionItems, sandboxActionItems } = workspaceEnvironmentActionItems({
    busy,
    canCreateSandboxProject,
    canInitGit,
    defaultSandboxRepoUrl: selectedAppRepoUrl ?? "",
    gitWorkspace,
    hasRemote,
    isProjectWorkspace,
    isSandboxWorkspace,
    managed,
    onOpenCommitDialog,
    onRunTerminalCommand,
    onWorkspaceToolAction,
    projectSandboxTemplate,
    projectSandboxTemplateValid,
    sandboxTemplateActionTargetCount: sandboxTemplateActionTargets.length,
    sandboxTemplateServiceTargets,
    selectedApp,
    selectedProject,
    setSandboxCreateDialogOpen,
    setSandboxRunActionDialogOpen,
    workspaceBusyValue,
    workspaceReady,
    workspaceState,
  });

  if (!workspaceState) return null;

  function selectMenuAction(item: EnvironmentActionItem) {
    setOpen(false);
    void item.onSelect();
  }

  return (
    <>
      <div
        className={`workspace-environment-menu ${mode === "dock" ? "open-up" : ""} ${
          mode === "topbar" ? "topbar" : ""
        }`}
        ref={menuRef}
      >
        <button
          type="button"
          className={`environment-info-button ${mode === "topbar" ? "titlebar-icon" : "composer-icon"} ${
            open ? "active" : ""
          }`}
          title="Environment"
          data-tooltip="Environment"
          aria-label="Environment"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <Info size={16} />
        </button>
        {open && (
          <div className="environment-popover" role="menu" aria-label="Environment">
            <div className="environment-popover-header">
              <span>Environment</span>
            </div>
            {isProjectWorkspace && selectedProject ? (
              <button
                type="button"
                className="environment-row"
                disabled={agentSetupLoading || !agentSetup.canAct || agentSetupBusy}
                title={agentSetupLoading ? "Loading Agent setup state" : (agentSetup.reason ?? "Set up this project as an Agent")}
                onClick={() => {
                  if (agentSetupLoading || !agentSetup.canAct) return;
                  if (agentSetup.state === "missing_config") setAgentSetupDialog("config");
                  if (agentSetup.state === "needs_project") setAgentSetupDialog("connect");
                  if (agentSetup.state === "needs_sync") setAgentSetupDialog("sync");
                  if (agentSetup.state === "needs_agent") setAgentSetupDialog("agent");
                  if (agentSetup.state === "ready") setAgentSetupDialog("run");
                  setOpen(false);
                }}
              >
                <Boxes size={15} />
                <span>
                  <strong>Agent setup</strong>
                  <small>{agentSetupLoading ? "Loading setup state" : agentSetupStatusLabel(agentSetup.state, agentSetup.reason)}</small>
                </span>
                <span className="environment-row-action">
                  {agentSetupBusy ? "Working" : agentSetupLoading ? "Loading" : agentSetup.actionLabel}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              className={`environment-row ${diffPanelOpen ? "active" : ""}`}
              disabled={!showDiffControls || !onToggleDiffPanel}
              onClick={() => {
                setOpen(false);
                onToggleDiffPanel?.();
              }}
            >
              <PanelRight size={15} />
              <span>
                <strong>Changes</strong>
                <small>{hasDiffs ? `${filesChanged} changed ${filesChanged === 1 ? "file" : "files"}` : "No changes"}</small>
              </span>
              {(hasDiffs || workspaceDiff) && (
                <span className="environment-change-counts">
                  <span className="diff-addition">+{additions}</span>
                  <span className="diff-deletion">-{deletions}</span>
                </span>
              )}
            </button>
            <div className="environment-row static">
              <Monitor size={15} />
              <span>
                <strong>{sourceLabel}</strong>
                <small>{workspaceState.repoPath || workspaceState.workspacePath}</small>
              </span>
            </div>
            <button
              type="button"
              className={`environment-row ${branchOpen ? "active" : ""}`}
              disabled={managed || !gitWorkspace || busy || workspaceBusyValue || !workspaceState.initialized}
              aria-expanded={branchOpen}
              onClick={() => setBranchOpen((current) => !current)}
            >
              <GitBranch size={15} />
              <span>
                <strong>{currentBranch}</strong>
                <small>
                  {managed
                    ? "Managed workspace"
                    : gitWorkspace
                      ? "Branch"
                      : "Git not initialized"}
                </small>
              </span>
              <ChevronDown size={13} />
            </button>
            {branchOpen && (
              <div className="environment-branch-panel">
                <label className="environment-branch-search">
                  <Search size={13} />
                  <input
                    ref={branchSearchRef}
                    value={branchQuery}
                    placeholder="Search branches"
                    onChange={(event) => setBranchQuery(event.target.value)}
                  />
                </label>
                <div className="environment-branch-list">
                  {filteredBranches.map((branch) => {
                    const selected = branch === workspaceState.currentBranch;
                    const disabled = busy || (workspaceState.dirty && !selected);
                    return (
                      <button
                        key={branch}
                        type="button"
                        className={selected ? "selected" : ""}
                        disabled={disabled}
                        role="menuitemradio"
                        aria-checked={selected}
                        title={disabled && !selected ? "Commit or discard local changes before switching branches." : branch}
                        onClick={() => {
                          setOpen(false);
                          if (!selected) onWorkspaceBranchChange?.(branch);
                        }}
                      >
                        <GitBranch size={13} />
                        <span>
                          <strong>{branch}</strong>
                          {selected && workspaceState.dirty && (
                            <small>
                              Uncommitted: {workspaceState.changedFilesCount}{" "}
                              {workspaceState.changedFilesCount === 1 ? "file" : "files"}
                            </small>
                          )}
                        </span>
                        {selected && <Check size={14} />}
                      </button>
                    );
                  })}
                  {filteredBranches.length === 0 && <div className="environment-branch-empty">No branches found</div>}
                </div>
                <button
                  type="button"
                  className="environment-branch-create"
                  disabled={busy || !workspaceState.initialized || !onWorkspaceBranchCreate}
                  onClick={() => {
                    setOpen(false);
                    onWorkspaceBranchCreate?.();
                  }}
                >
                  <GitBranch size={14} />
                  <span>Create branch</span>
                </button>
              </div>
            )}
            <div className="environment-section-title">Git</div>
            {gitActionItems.map((item) => (
              <button
                key={item.label}
                type="button"
                className="environment-action"
                disabled={item.disabled}
                onClick={() => selectMenuAction(item)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
            <div className="environment-section-title">Sandbox</div>
            {sandboxActionItems.map((item) => (
              <button
                key={item.label}
                type="button"
                className="environment-action"
                disabled={item.disabled}
                onClick={() => selectMenuAction(item)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {sandboxCreateDialogOpen && (
        <SandboxCreateDialog
          busy={workspaceBusyValue}
          commitBeforeCreate={(canPublishProject || (gitWorkspace && hasRemote)) && Boolean(workspaceState?.dirty)}
          defaultRepoUrl={projectRemoteUrl}
          projectName={selectedProject?.name ?? "sandbox template"}
          templateManifest={selectedProject?.sandboxTemplate?.normalizedManifest ?? null}
          uploadBeforeCreate={canPublishProject}
          onClose={() => {
            if (!workspaceBusyValue) setSandboxCreateDialogOpen(false);
          }}
          onSubmit={(input) => void createSandboxFromProject(input)}
        />
      )}
      {sandboxRunActionDialogOpen && (
        <SandboxRunActionDialog
          busy={workspaceBusyValue}
          projectName={selectedProject?.name ?? "sandbox template"}
          templateManifest={selectedProject?.sandboxTemplate?.normalizedManifest ?? null}
          onClose={() => {
            if (!workspaceBusyValue) setSandboxRunActionDialogOpen(false);
          }}
          onSubmit={(input) => void runSandboxTemplateAction(input)}
        />
      )}
      {agentSetupDialog === "config" && selectedProject ? (
        <AgentConfigDialog
          busy={agentSetupBusy}
          error={agentSetupError}
          projectName={selectedProject.name}
          onClose={() => !agentSetupBusy && setAgentSetupDialog(null)}
          onSubmit={(input) => void submitAgentConfig(input)}
        />
      ) : null}
      {agentSetupDialog === "connect" && selectedProject && implicitTeam ? (
        <ConnectProjectDialog
          busy={agentSetupBusy}
          error={agentSetupError}
          defaultTeamId={implicitTeam.teamId}
          projectName={selectedProject.name}
          sourceIdentity={workspaceState?.remoteUrl ?? ""}
          defaultBranch={workspaceState?.currentBranch ?? "main"}
          onClose={() => !agentSetupBusy && setAgentSetupDialog(null)}
          onSubmit={(input) => void submitConnectProject(input)}
        />
      ) : null}
      {agentSetupDialog === "sync" && agentSetup.project ? (
        <ConfirmAgentSetupDialog
          busy={agentSetupBusy}
          error={agentSetupError}
          title="Sync Project"
          actionLabel="Sync Project"
          summary={`${agentSetup.project.name} · ${agentSetup.project.sandboxManifestPath ?? OPENPOND_MANIFEST_FILE_NAME}`}
          onClose={() => !agentSetupBusy && setAgentSetupDialog(null)}
          onSubmit={() => void submitSyncProject()}
        />
      ) : null}
      {agentSetupDialog === "agent" && agentSetup.project ? (
        <CreateAgentDialog
          busy={agentSetupBusy}
          error={agentSetupError}
          defaultName={`${selectedProject?.name ?? agentSetup.project.name} Agent`}
          onClose={() => !agentSetupBusy && setAgentSetupDialog(null)}
          onSubmit={(input) => void submitCreateAgent(input)}
        />
      ) : null}
      {agentSetupDialog === "run" && agentSetup.agent ? (
        <ConfirmAgentSetupDialog
          busy={agentSetupBusy}
          error={agentSetupError}
          title="Run Agent"
          actionLabel="Run Agent"
          summary={agentSetup.agent.name}
          onClose={() => !agentSetupBusy && setAgentSetupDialog(null)}
          onSubmit={() => void submitRunAgent()}
        />
      ) : null}
    </>
  );
}
