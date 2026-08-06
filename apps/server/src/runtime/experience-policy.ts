import type {
  Experience,
  Session,
  WorkspaceToolRequest,
} from "@openpond/contracts";
import type { ModelToolDefinition } from "../openpond/model-tool-registry.js";

const CHAT_MODEL_TOOLS = new Set(["view_image", "web_fetch", "web_search"]);

const WORK_MODEL_TOOLS = new Set([
  "ask_user",
  "connected_app_read",
  "connected_app_search",
  "connected_app_skill_read",
  "connected_app_write",
  "harness_inspect",
  "context_read",
  "manage_sidebar_file",
  "memory_inspect",
  "memory_search",
  "openpond_browser_click",
  "openpond_browser_key",
  "openpond_browser_move_cursor",
  "openpond_browser_open",
  "openpond_browser_scroll",
  "openpond_browser_snapshot",
  "openpond_browser_type",
  "openpond_subagent_cancel",
  "openpond_subagent_followup",
  "openpond_subagent_join",
  "openpond_subagent_send_message",
  "openpond_subagent_start",
  "openpond_subagent_status",
  "profile_skill_read",
  "refine_request",
  "refine_status",
  "schedule_work",
  "skill_inspect",
  "view_image",
  "web_fetch",
  "web_search",
]);

const WORK_WORKSPACE_TOOLS = new Set<WorkspaceToolRequest["action"]>([
  "sandbox_create",
  "sandbox_status",
  "sandbox_start",
  "sandbox_list_files",
  "sandbox_read_file",
  "sandbox_search_files",
  "sandbox_upload_file",
  "sandbox_write_file",
  "sandbox_edit_file",
  "sandbox_delete_file",
  "sandbox_mkdir",
  "sandbox_move_file",
  "sandbox_exec",
  "sandbox_open_port",
  "sandbox_snapshot_catalog",
  "sandbox_snapshot_create",
  "sandbox_snapshot_update",
  "sandbox_snapshot_validate",
  "sandbox_prepare_agent",
  "sandbox_save_agent_package",
  "sandbox_save_output",
  "work_agent_package_install",
  "work_output_delete",
  "work_output_read",
  "sandbox_stop",
]);

export function modelToolAllowedForExperience(
  experience: Experience,
  toolName: string
): boolean {
  if (experience === "development") return !toolName.startsWith("work_");
  if (experience === "chat") return CHAT_MODEL_TOOLS.has(toolName);
  return WORK_MODEL_TOOLS.has(toolName) || toolName.startsWith("work_");
}

export function filterModelToolsForExperience(
  session: Pick<Session, "experience" | "workspaceKind" | "localProjectId" | "cloudProjectId">,
  definitions: ModelToolDefinition[]
): ModelToolDefinition[] {
  if (sessionUsesRepositoryWork(session)) {
    return definitions.filter((definition) => !definition.name.startsWith("work_"));
  }
  return definitions.filter((definition) =>
    modelToolAllowedForExperience(session.experience, definition.name)
  );
}

export function workspaceToolAllowedForExperience(
  experience: Experience,
  action: WorkspaceToolRequest["action"]
): boolean {
  if (experience === "development") return true;
  if (experience === "chat") return false;
  return WORK_WORKSPACE_TOOLS.has(action);
}

export function workspaceToolExperienceBlocker(input: {
  session: Pick<Session, "experience" | "workspaceKind" | "localProjectId" | "cloudProjectId">;
  action: WorkspaceToolRequest["action"];
  args?: Record<string, unknown>;
}): string | null {
  if (sessionUsesRepositoryWork(input.session)) return null;
  if (
    workspaceToolAllowedForExperience(input.session.experience, input.action)
  ) {
    if (input.session.experience !== "work") return null;
    return workWorkspaceRequestBlocker(input.action, input.args ?? {});
  }
  if (input.session.experience === "chat") {
    return "Chat does not have workspace compute. Start Work to use Local or Hosted workspace tools.";
  }
  return `${input.action} requires repository-aware Work and is not available in this projectless Work run.`;
}

function workWorkspaceRequestBlocker(
  action: WorkspaceToolRequest["action"],
  args: Record<string, unknown>
): string | null {
  if (action === "sandbox_create") {
    const runtime =
      args.runtime &&
      typeof args.runtime === "object" &&
      !Array.isArray(args.runtime)
        ? (args.runtime as Record<string, unknown>)
        : {};
    const forbiddenTextKeys = ["agentId", "projectId", "repo", "teamId"];
    if (
      forbiddenTextKeys.some(
        (key) => typeof args[key] === "string" && args[key].trim().length > 0
      )
    ) {
      return "Work sandboxes must be projectless and cannot attach a repository, Agent, Project, or Team.";
    }
    if (
      runtime.runtimeProfileId !== "openpond-work-v1" ||
      args.visibility !== "private" ||
      args.reuseDefaultRuntime !== false ||
      args.markDefaultRuntime !== false
    ) {
      return "Work sandbox creation must use the private openpond-work-v1 projectless profile.";
    }
    if (args.command !== "mkdir -p inputs work outputs") {
      return "Work sandbox creation must initialize the standard inputs, work, and outputs directories.";
    }
    return null;
  }

  if (action === "sandbox_exec") {
    const command =
      typeof args.command === "string" ? args.command.trimStart() : "";
    return command.startsWith("cd /workspace/work && ")
      ? null
      : "Work commands must execute from /workspace/work.";
  }

  if (
    action === "work_agent_package_install" ||
    action === "work_output_delete" ||
    action === "work_output_read"
  ) {
    return typeof args.outputId === "string" && args.outputId.trim()
      ? null
      : "A Work output id is required.";
  }

  const pathRules: Partial<
    Record<WorkspaceToolRequest["action"], readonly string[]>
  > = {
    sandbox_delete_file: ["work", "outputs"],
    sandbox_edit_file: ["work", "outputs"],
    sandbox_list_files: ["inputs", "work", "outputs"],
    sandbox_mkdir: ["work", "outputs"],
    sandbox_read_file: ["inputs", "work", "outputs"],
    sandbox_save_output: ["outputs"],
    sandbox_search_files: ["inputs", "work", "outputs"],
    sandbox_upload_file: ["inputs"],
    sandbox_write_file: ["work", "outputs"],
  };
  const allowedRoots = pathRules[action];
  if (allowedRoots) {
    return workPathBlocker(args.path, allowedRoots);
  }
  if (action === "sandbox_move_file") {
    return (
      workPathBlocker(args.fromPath, ["work", "outputs"]) ??
      workPathBlocker(args.toPath, ["work", "outputs"])
    );
  }
  return null;
}

function workPathBlocker(
  rawPath: unknown,
  allowedRoots: readonly string[]
): string | null {
  if (typeof rawPath !== "string") return "A bounded Work path is required.";
  const path = rawPath.trim().replaceAll("\\", "/");
  if (
    !path ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "..") ||
    !allowedRoots.some((root) => path === root || path.startsWith(`${root}/`))
  ) {
    return `Work paths must stay under ${allowedRoots
      .map((root) => `/workspace/${root}`)
      .join(", ")}.`;
  }
  return null;
}

export function experienceUsesWorkspaceToolProtocol(
  experience: Experience | Pick<Session, "experience" | "workspaceKind" | "localProjectId" | "cloudProjectId">
): boolean {
  return typeof experience === "string"
    ? experience === "development"
    : sessionUsesRepositoryWork(experience);
}

export function experienceAllowsConnectedApps(experience: Experience): boolean {
  return experience !== "chat";
}

export function experienceAllowsProfileSkills(experience: Experience): boolean {
  return experience !== "chat";
}

export function experienceAllowsAuthoring(
  experience: Experience | Pick<Session, "experience" | "workspaceKind" | "localProjectId" | "cloudProjectId">,
): boolean {
  return typeof experience === "string"
    ? experience === "development"
    : sessionUsesRepositoryWork(experience);
}

export function sessionUsesRepositoryWork(
  session: Pick<Session, "experience" | "workspaceKind" | "localProjectId" | "cloudProjectId">,
): boolean {
  return session.experience === "development" || (
    session.experience === "work" &&
    (
      session.workspaceKind === "local_project" ||
      Boolean(session.localProjectId) ||
      Boolean(session.cloudProjectId)
    )
  );
}
