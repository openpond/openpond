import type {
  LocalProject,
  Session,
  WorkspaceCapabilities,
  WorkspaceState,
  WorkspaceToolRequest,
} from "@openpond/contracts";

type ResolveWorkspaceCapabilitiesInput = {
  session: Session;
  localProject?: LocalProject | null;
  state?: WorkspaceState | null;
};

type WorkspaceToolRouteInput = ResolveWorkspaceCapabilitiesInput & {
  action: WorkspaceToolRequest["action"];
  capabilities?: WorkspaceCapabilities;
};

const SANDBOX_RUNTIME_ACTION_PREFIX = "sandbox_";
const SANDBOX_TEMPLATE_ACTIONS = new Set<WorkspaceToolRequest["action"]>([
  "validate_sandbox_template",
  "build_sandbox_template",
  "run_sandbox_template",
]);

export function resolveWorkspaceCapabilities({
  session,
  localProject,
  state,
}: ResolveWorkspaceCapabilitiesInput): WorkspaceCapabilities {
  const productKind = (() => {
    if (session.workspaceKind === "sandbox" || session.workspaceKind === "sandbox_template") return "sandbox";
    if (localProject?.sandboxTemplate?.detected) return "sandbox_template";
    if (localProject?.source === "git" || localProject?.repoPath || isGitBackedWorkspaceState(state)) {
      return "generic_git";
    }
    return "plain_folder";
  })();

  const git =
    productKind === "sandbox_template" ||
    productKind === "generic_git" ||
    isGitBackedWorkspaceState(state);
  const sandboxTemplate = productKind === "sandbox_template";
  const sandboxRuntime = productKind === "sandbox" || sandboxTemplate;

  return {
    productKind,
    actions: {
      files: productKind !== "sandbox",
      git,
      sandboxRuntime,
      sandboxTemplate,
    },
    checks: {
      validate: sandboxTemplate ? "validate_sandbox_template" : null,
      build: sandboxTemplate ? "build_sandbox_template" : null,
      postEdit: sandboxTemplate ? "sandbox_template" : null,
    },
    ui: {
      showSandboxTemplateActions: sandboxTemplate,
      showSandboxRuntimeActions: sandboxRuntime,
    },
  };
}

export function workspaceToolBlockedMessage(input: WorkspaceToolRouteInput): string | null {
  const capabilities =
    input.capabilities ??
    resolveWorkspaceCapabilities({
      session: input.session,
      localProject: input.localProject,
      state: input.state,
    });

  if (input.session.workspaceKind === "sandbox" || input.session.workspaceKind === "sandbox_template") {
    return isSandboxRuntimeAction(input.action) ? null : "Use sandbox_* workspace actions for sandbox workspaces.";
  }

  if (SANDBOX_TEMPLATE_ACTIONS.has(input.action) && !capabilities.actions.sandboxTemplate) {
    return "Sandbox template actions are only available for projects with openpond.yaml.";
  }

  return null;
}

function isSandboxRuntimeAction(action: WorkspaceToolRequest["action"]): boolean {
  return action.startsWith(SANDBOX_RUNTIME_ACTION_PREFIX);
}

function isGitBackedWorkspaceState(state?: WorkspaceState | null): boolean {
  return state?.source === "openpond" || state?.source === "github" || state?.source === "local_git";
}
