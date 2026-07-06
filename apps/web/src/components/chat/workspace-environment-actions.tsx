import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { OpenPondApp, LocalProject, WorkspaceState, WorkspaceToolRequest, WorkspaceToolResult } from "@openpond/contracts";
import { OPENPOND_MANIFEST_FILE_NAME } from "@openpond/contracts";
import {
  Activity,
  Boxes,
  CheckCircle2,
  Download,
  FolderGit2,
  GitCommitHorizontal,
  Github,
  Hammer,
  Play,
  RefreshCw,
  Square,
  SquareTerminal,
  Upload,
} from "../icons";
import type { CommitNextStep } from "../workspace/WorkspaceGitDialogs";
import { sandboxTemplateTerminalCommand } from "./workspace-environment-helpers";

export type EnvironmentActionItem = {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onSelect: () => void | Promise<unknown>;
};

export type WorkspaceToolActionHandler = (
  action: WorkspaceToolRequest["action"],
  args?: Record<string, unknown>,
) => Promise<WorkspaceToolResult | null>;

export type SandboxResumeTarget = {
  id: string;
  runtimeId: string | null;
  teamId: string | null;
  projectId: string | null;
  state: string | null;
};

export async function checkpointAndStopSandbox(onWorkspaceToolAction?: WorkspaceToolActionHandler): Promise<void> {
  if (!onWorkspaceToolAction) return;
  await onWorkspaceToolAction("sandbox_preserve_source");
  // Stop keeps the server-side unpreserved-change guard, and can still clean up after stale placement blocks preservation.
  await onWorkspaceToolAction("sandbox_stop");
}

export function sandboxResumeArgs(target: SandboxResumeTarget): Record<string, unknown> {
  return {
    ...(target.teamId ? { teamId: target.teamId } : {}),
    ...(target.projectId ? { projectId: target.projectId } : {}),
    runtime: {
      runtimeId: target.runtimeId,
    },
    visibility: "team",
    budget: { maxUsd: "0.05" },
    quotas: {
      idleTimeoutSeconds: 15 * 60,
      maxSpendUsd: "0.05",
    },
    metadata: {
      source: "openpond-app-environment-menu-sandbox-resume",
      resumeSandboxId: target.id,
      previousState: target.state,
    },
  };
}

export function workspaceEnvironmentActionItems({
  busy,
  canCreateSandboxProject,
  canInitGit,
  defaultSandboxRepoUrl,
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
  sandboxTemplateActionTargetCount,
  sandboxTemplateServiceTargets,
  sandboxResumeTarget,
  selectedApp,
  selectedProject,
  setSandboxCreateDialogOpen,
  setSandboxRunActionDialogOpen,
  workspaceBusyValue,
  workspaceReady,
  workspaceState,
}: {
  busy: boolean;
  canCreateSandboxProject: boolean;
  canInitGit: boolean;
  defaultSandboxRepoUrl: string;
  gitWorkspace: boolean;
  hasRemote: boolean;
  isProjectWorkspace: boolean;
  isSandboxWorkspace: boolean;
  managed: boolean;
  onOpenCommitDialog?: (nextStep?: CommitNextStep) => void;
  onRunTerminalCommand?: (command: string) => void;
  onWorkspaceToolAction?: WorkspaceToolActionHandler;
  projectSandboxTemplate: boolean;
  projectSandboxTemplateValid: boolean;
  sandboxTemplateActionTargetCount: number;
  sandboxTemplateServiceTargets: Array<{ name: string }>;
  sandboxResumeTarget?: SandboxResumeTarget | null;
  selectedApp?: OpenPondApp | null;
  selectedProject?: LocalProject | null;
  setSandboxCreateDialogOpen: Dispatch<SetStateAction<boolean>>;
  setSandboxRunActionDialogOpen: Dispatch<SetStateAction<boolean>>;
  workspaceBusyValue: boolean;
  workspaceReady: boolean;
  workspaceState?: WorkspaceState | null;
}) {
  const gitActionItems: EnvironmentActionItem[] = [
    {
      icon: <FolderGit2 size={14} />,
      label: "Initialize Git",
      disabled: managed || !canInitGit || workspaceBusyValue || !workspaceReady || !onWorkspaceToolAction,
      onSelect: () => onWorkspaceToolAction?.("git_init"),
    },
    {
      icon: <GitCommitHorizontal size={14} />,
      label: "Commit changes",
      disabled: managed || !gitWorkspace || workspaceBusyValue || !workspaceReady || !workspaceState?.dirty || !onOpenCommitDialog,
      onSelect: () => onOpenCommitDialog?.("commit"),
    },
    {
      icon: <Upload size={14} />,
      label: "Push branch",
      disabled: managed || !gitWorkspace || workspaceBusyValue || !workspaceReady || !hasRemote || !onWorkspaceToolAction,
      onSelect: () => onWorkspaceToolAction?.("git_push"),
    },
    {
      icon: <RefreshCw size={14} />,
      label: "Fetch remote",
      disabled: managed || !gitWorkspace || workspaceBusyValue || !workspaceReady || !hasRemote || !onWorkspaceToolAction,
      onSelect: () => onWorkspaceToolAction?.("git_fetch"),
    },
    {
      icon: <Github size={14} />,
      label: "Create PR",
      disabled: true,
      onSelect: () => undefined,
    },
  ];
  const localProjectSandboxItems: EnvironmentActionItem[] = [
    ...(!projectSandboxTemplate
      ? [
          {
            icon: <Boxes size={14} />,
            label: "Create sandbox template",
            disabled: managed || workspaceBusyValue || !workspaceReady || !onWorkspaceToolAction,
            onSelect: () => onWorkspaceToolAction?.("create_sandbox_template_scaffold"),
          },
        ]
      : []),
    {
      icon: <CheckCircle2 size={14} />,
      label: `Validate ${OPENPOND_MANIFEST_FILE_NAME}`,
      disabled: managed || workspaceBusyValue || !workspaceReady || !onWorkspaceToolAction,
      onSelect: () => onWorkspaceToolAction?.("validate_sandbox_template"),
    },
    {
      icon: <Hammer size={14} />,
      label: "Build template",
      disabled: managed || workspaceBusyValue || !workspaceReady || !onWorkspaceToolAction,
      onSelect: () => onWorkspaceToolAction?.("build_sandbox_template"),
    },
    {
      icon: <Play size={14} />,
      label: "Run start locally",
      disabled: managed || workspaceBusyValue || !workspaceReady || !onWorkspaceToolAction,
      onSelect: () => onWorkspaceToolAction?.("run_sandbox_template", { mode: "local", target: "start" }),
    },
    {
      icon: <Play size={14} />,
      label: "Run action",
      disabled:
        managed ||
        workspaceBusyValue ||
        !workspaceReady ||
        !projectSandboxTemplateValid ||
        sandboxTemplateActionTargetCount === 0,
      onSelect: () => setSandboxRunActionDialogOpen(true),
    },
    ...sandboxTemplateServiceTargets.map((target): EnvironmentActionItem => ({
      icon: <SquareTerminal size={14} />,
      label: `Dev ${target.name} locally`,
      disabled:
        managed ||
        workspaceBusyValue ||
        !workspaceReady ||
        !projectSandboxTemplateValid ||
        !selectedProject?.sandboxTemplate?.rootPath ||
        !onRunTerminalCommand,
      onSelect: () =>
        onRunTerminalCommand?.(
          sandboxTemplateTerminalCommand(
            selectedProject?.sandboxTemplate?.rootPath ?? "",
            "dev",
            target.name,
          ),
        ),
    })),
    {
      icon: <Boxes size={14} />,
      label: "Start sandbox",
      disabled: managed || workspaceBusyValue || !workspaceReady || !canCreateSandboxProject,
      onSelect: () => setSandboxCreateDialogOpen(true),
    },
  ];
  const sandboxWorkspaceItems: EnvironmentActionItem[] = [
    {
      icon: <RefreshCw size={14} />,
      label: "Sandbox status",
      disabled: workspaceBusyValue || !onWorkspaceToolAction,
      onSelect: () => onWorkspaceToolAction?.("sandbox_status"),
    },
    {
      icon: <Play size={14} />,
      label: "Resume sandbox",
      disabled:
        workspaceBusyValue ||
        !onWorkspaceToolAction ||
        !sandboxResumeTarget?.runtimeId ||
        sandboxResumeTarget.state === "running" ||
        sandboxResumeTarget.state === "creating",
      onSelect: () =>
        sandboxResumeTarget?.runtimeId
          ? onWorkspaceToolAction?.("sandbox_create", sandboxResumeArgs(sandboxResumeTarget))
          : undefined,
    },
    {
      icon: <Activity size={14} />,
      label: "Sandbox logs",
      disabled: workspaceBusyValue || !onWorkspaceToolAction,
      onSelect: () => onWorkspaceToolAction?.("sandbox_logs"),
    },
    {
      icon: <CheckCircle2 size={14} />,
      label: "Receipts",
      disabled: workspaceBusyValue || !onWorkspaceToolAction,
      onSelect: () => onWorkspaceToolAction?.("sandbox_receipts"),
    },
    {
      icon: <Download size={14} />,
      label: "Export patch",
      disabled: workspaceBusyValue || !onWorkspaceToolAction,
      onSelect: () => onWorkspaceToolAction?.("sandbox_git_export_patch"),
    },
    {
      icon: <Upload size={14} />,
      label: "Apply locally",
      disabled: workspaceBusyValue || !onWorkspaceToolAction,
      onSelect: () => onWorkspaceToolAction?.("sandbox_git_apply_patch_local"),
    },
    {
      icon: <Square size={14} />,
      label: "Checkpoint and stop",
      disabled: workspaceBusyValue || !onWorkspaceToolAction,
      onSelect: () => checkpointAndStopSandbox(onWorkspaceToolAction),
    },
  ];
  const defaultSandboxItems: EnvironmentActionItem[] = [
    {
      icon: <Boxes size={14} />,
      label: defaultSandboxRepoUrl ? "Create sandbox from repo" : "Create sandbox",
      disabled: workspaceBusyValue || !onWorkspaceToolAction,
      onSelect: () =>
        onWorkspaceToolAction?.("sandbox_create", {
          ...(defaultSandboxRepoUrl ? { repo: defaultSandboxRepoUrl } : {}),
          visibility: "team",
          budget: { maxUsd: "0.05" },
          quotas: { maxSpendUsd: "0.05" },
          metadata: {
            source: "openpond-app-environment-menu-sandbox",
            ...(selectedApp?.name ? { appName: selectedApp.name } : {}),
          },
        }),
    },
    {
      icon: <RefreshCw size={14} />,
      label: "List templates",
      disabled: workspaceBusyValue || !onWorkspaceToolAction,
      onSelect: () => onWorkspaceToolAction?.("sandbox_templates"),
    },
  ];
  const sandboxActionItems = isSandboxWorkspace
    ? sandboxWorkspaceItems
    : isProjectWorkspace
      ? localProjectSandboxItems
      : defaultSandboxItems;

  return {
    gitActionItems,
    sandboxActionItems,
  };
}
