import type {
  Approval,
  CreateImproveRun,
  Session,
} from "@openpond/contracts";
import type { RightChatPanel } from "../../app/app-state";
import type { ChatMessage } from "../../lib/app-models";
import type { ContextWindowStatus } from "../../lib/context-window";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { PendingChatUserMessage } from "../../lib/pending-chat-messages";

export type RightChatPanelView = RightChatPanel & {
  session: Session | null;
  title: string;
  messages: ChatMessage[];
  contextWindowStatus: ContextWindowStatus;
  goalRuntime: GoalRuntimeStatus | null;
  createImproveRun: CreateImproveRun | null;
  pendingApproval: Approval | null;
  running: boolean;
  steerAutoDispatchBlocked: boolean;
  steerAutoDispatchReady: boolean;
  workspaceRootPath: string | null;
  activeWorkspaceAppId: string | null;
  pendingUserMessage: PendingChatUserMessage | null;
  runtimeSource: "history" | "live";
};

export type RightChatScrollState = {
  scrollTop: number;
  stickyToBottom: boolean;
};
