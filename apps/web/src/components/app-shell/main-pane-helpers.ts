import type {
  BootstrapPayload,
  CloudProject,
  CloudWorkItem,
  CloudWorkItemDetail,
  UsageRequestAttribution,
  WorkspaceKind,
} from "@openpond/contracts";
import type { AppView, ChatMessage } from "../../lib/app-models";
import type { ParsedComposerSlashCommand } from "../../lib/composer-slash-commands";
import { isCloudWorkspaceKind } from "../../lib/workspace-location";
import type { ComposerCreatePipelineRuntime } from "../chat/ComposerCreatePipelineStrip";

const CHAT_AUTOSCROLL_THRESHOLD_PX = 72;
export const CHAT_HISTORY_TOP_THRESHOLD_PX = 120;
export const CHAT_USER_MESSAGE_SCROLL_OFFSET_PX = 24;
const CHAT_NAVIGATION_SCROLL_MIN_DURATION_MS = 280;
const CHAT_NAVIGATION_SCROLL_MAX_DURATION_MS = 460;

export function isNearChatBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= CHAT_AUTOSCROLL_THRESHOLD_PX;
}

export function insightsSystemSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { systemSessionId?: unknown }).systemSessionId;
  return typeof value === "string" && value.trim() ? value : null;
}

export type UserMessageNavigationState = {
  canGoPrevious: boolean;
  canGoNext: boolean;
};

export const EMPTY_USER_MESSAGE_NAVIGATION: UserMessageNavigationState = {
  canGoPrevious: false,
  canGoNext: false,
};

function userMessageRows(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>(".message-row.user")).filter(
    (row) => row.parentElement === element,
  );
}

export function billingTargetForContext({
  activeWorkspaceId,
  cloudProjects,
  selectedCloudWorkItem,
}: {
  activeWorkspaceId: string | null;
  cloudProjects: CloudProject[];
  selectedCloudWorkItem: CloudWorkItem | null;
}): { organizationSlug: string | null; teamId: string | null } {
  const selectedProject = cloudProjects.find((project) =>
    project.id === activeWorkspaceId ||
    project.id === selectedCloudWorkItem?.projectId ||
    project.teamId === selectedCloudWorkItem?.teamId
  );
  const fallbackProject = cloudProjects.find((project) => project.organizationSlug || project.teamId);
  const project = selectedProject ?? fallbackProject ?? null;
  return {
    organizationSlug: project?.organizationSlug ?? null,
    teamId: project?.teamId ?? selectedCloudWorkItem?.teamId ?? null,
  };
}

export function messageScrollTop(element: HTMLElement, message: HTMLElement): number {
  return message.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
}

function messageScrollBottom(element: HTMLElement, message: HTMLElement): number {
  return messageScrollTop(element, message) + message.getBoundingClientRect().height;
}

function userMessageNavigationAnchor(element: HTMLElement): number {
  return element.scrollTop + CHAT_USER_MESSAGE_SCROLL_OFFSET_PX;
}

function previousUserMessageThreshold(element: HTMLElement): number {
  return element.scrollTop + 8;
}

export function userMessageNavigationState(element: HTMLElement): UserMessageNavigationState {
  const anchor = userMessageNavigationAnchor(element);
  const previousThreshold = previousUserMessageThreshold(element);
  let canGoPrevious = false;
  let canGoNext = false;
  for (const row of userMessageRows(element)) {
    const top = messageScrollTop(element, row);
    if (messageScrollBottom(element, row) < previousThreshold) canGoPrevious = true;
    if (top > anchor + 8) canGoNext = true;
    if (canGoPrevious && canGoNext) break;
  }
  return { canGoPrevious, canGoNext };
}

export function nextUserMessageTarget(
  element: HTMLElement,
  direction: "previous" | "next",
): HTMLElement | null {
  const rows = userMessageRows(element);
  const anchor = userMessageNavigationAnchor(element);
  if (direction === "previous") {
    const previousThreshold = previousUserMessageThreshold(element);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (messageScrollBottom(element, row) < previousThreshold) return row;
    }
    return null;
  }

  for (const row of rows) {
    if (messageScrollTop(element, row) > anchor + 8) return row;
  }
  return null;
}

export function easedChatScrollDuration(distance: number): number {
  return Math.min(
    CHAT_NAVIGATION_SCROLL_MAX_DURATION_MS,
    Math.max(CHAT_NAVIGATION_SCROLL_MIN_DURATION_MS, Math.abs(distance) / 5),
  );
}

export function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

export function latestCreatePipelineRuntime(
  messages: ChatMessage[],
): Pick<ComposerCreatePipelineRuntime, "request" | "snapshot" | "turnId"> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!message.createPipelineRequest) continue;
    if (message.createPipeline?.state === "cancelled") continue;
    return {
      turnId: message.turnId ?? null,
      request: message.createPipelineRequest,
      snapshot: message.createPipeline ?? null,
    };
  }
  return null;
}

export function cloudProjectIdFromComposerTarget(value: string): string | null {
  return value.startsWith("cloud:") ? value.slice("cloud:".length) || null : null;
}

export function promptForAppSlashCommand(command: ParsedComposerSlashCommand): string {
  if (command.command === "create") return `/create ${command.args}`;
  if (command.command === "edit") return `/edit ${command.args}`;
  if (command.command === "skill") return command.args ? `/skill ${command.args}` : "/skill";
  if (command.command === "sync-cloud") return command.args ? `/sync-cloud ${command.args}` : "/sync-cloud";
  if (command.command === "goal-local") return `Goal: ${command.args}`;
  return `Goal: ${command.args}`;
}

export function usageAttributionForComposerSlashCommand(
  command: ParsedComposerSlashCommand,
  commandSource: UsageRequestAttribution["commandSource"],
): UsageRequestAttribution {
  return {
    surface: "chat",
    workflowKind: "slash_command",
    commandName: `/${command.command}`,
    commandSource,
  };
}

export function shouldSubmitComposerSlashCommandToChat(command: ParsedComposerSlashCommand): boolean {
  return (
    command.command === "goal" ||
    command.command === "goal-local" ||
    command.command === "skill" ||
    command.command === "sync-cloud"
  );
}

export function shouldRunCreatePipelineCommandLocally(input: {
  command: ParsedComposerSlashCommand;
  profile: BootstrapPayload["profile"] | null | undefined;
  activeWorkspaceKind: WorkspaceKind | null;
  view: AppView;
}): boolean {
  if (input.command.command !== "create" && input.command.command !== "edit") {
    return false;
  }
  if (input.profile?.mode !== "local") return false;
  if (input.view === "cloud") return false;
  return !isCloudWorkspaceKind(input.activeWorkspaceKind);
}

export function cloudWorkItemSandboxId(
  workItem: CloudWorkItem | null,
  detail: CloudWorkItemDetail | null,
): string | null {
  if (!workItem) return null;
  const detailApplies = detail?.workItem.id === workItem.id;
  return (
    (detailApplies ? detail.workItem.latestSandboxId : null) ??
    workItem.latestSandboxId ??
    (detailApplies
      ? detail.runtimeSessions.find((session) => session.sandboxId && !session.endedAt)?.sandboxId ??
        detail.runtimeSessions.find((session) => session.sandboxId)?.sandboxId ??
        null
      : null)
  );
}

export function sandboxIdFromWorkspaceName(workspaceName: string | null): string | null {
  const trimmed = workspaceName?.trim() ?? "";
  return /^[a-z0-9]{24}$/.test(trimmed) ? trimmed : null;
}
