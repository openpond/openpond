import { ChatProviderSchema } from "@openpond/contracts";
import { z } from "zod";
import type { WorkspaceDiffPanelViewState } from "../components/workspace-diff/workspace-diff-panel-model";
import type { RightSidebarConversationState } from "./right-sidebar-conversation-state";

const KEY = "openpond.conversation-sidebar-recovery.v1";
const MAX_SNAPSHOT_CHARACTERS = 512 * 1024;
const SnapshotSchema = z.object({
  conversations: z.record(z.string(), z.object({
    diffPanelOpen: z.boolean(),
    diffPanelExpanded: z.boolean(),
    rightPanelMode: z.enum(["home", "changes", "browser", "goal", "chat", "training"]),
    rightChatPanels: z.array(z.object({
      id: z.string(), activationVersion: z.number(), sessionId: z.string().nullable(),
      prompt: z.string(), provider: ChatProviderSchema, model: z.string(),
      scrollTop: z.number(), stickyToBottom: z.boolean(),
    })).max(100),
  })).refine(entries => Object.keys(entries).length <= 512),
  workspaces: z.record(z.string(), z.object({
    activeTab: z.enum(["goal", "summary", "files", "file", "outputs"]),
    openFilePaths: z.array(z.string()).max(200), selectedPath: z.string().nullable(),
    filesTabOpen: z.boolean(), overviewTabs: z.array(z.number().int()).max(200),
    activeOverviewId: z.number().int(), tabOrder: z.array(z.string()).max(400),
  })).refine(entries => Object.keys(entries).length <= 1024),
});

export type ConversationSidebarSnapshot = {
  conversations: Record<string, RightSidebarConversationState>;
  workspaces: Record<string, WorkspaceDiffPanelViewState>;
};

export function restoreConversationSidebarSnapshot(storage?: Storage): ConversationSidebarSnapshot {
  try {
    const raw = (storage ?? window.localStorage).getItem(KEY);
    if (raw && raw.length <= MAX_SNAPSHOT_CHARACTERS) {
      const parsed = SnapshotSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    }
  } catch { /* Unavailable or invalid recovery data never replaces live state. */ }
  return { conversations: {}, workspaces: {} };
}

export function saveConversationSidebarSnapshot(snapshot: ConversationSidebarSnapshot, storage: Storage = window.localStorage): void {
  const serialized = JSON.stringify(SnapshotSchema.parse(snapshot));
  if (serialized.length > MAX_SNAPSHOT_CHARACTERS) throw new Error("Sidebar state exceeds local recovery capacity.");
  storage.setItem(KEY, serialized);
}
