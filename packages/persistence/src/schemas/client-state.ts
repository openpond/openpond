import { z } from "zod";

export const ClientChoicesSchema = z.strictObject({
  chatMode: z.enum(["chat", "work"]).optional(),
  notificationMode: z.enum(["all", "direct_mentions", "none"]).optional(),
  learningNoticeDismissed: z.boolean().optional(),
  sidebarVisibility: z.strictObject({ showCodexChats: z.boolean(), onlyRunningTasks: z.boolean() }).optional(),
  scheduledWorkView: z.enum(["calendar", "list"]).optional(),
  editorControlsVisible: z.boolean().optional(),
  voiceNoticeAcknowledged: z.boolean().optional(),
  lessonProgress: z.record(z.string().min(1).max(200), z.strictObject({ completed: z.boolean(), currentTime: z.number().finite().nonnegative(), duration: z.number().finite().positive(), updatedAt: z.number().finite().nonnegative() })).refine((value) => Object.keys(value).length <= 200, "Too many lessons").optional(),
});
export type ClientChoices = z.infer<typeof ClientChoicesSchema>;
export const CLIENT_CHOICE_KEYS = {
  "openpond:last-chat-task-mode": "chatMode",
  "openpond.team-chat.notification-mode": "notificationMode",
  "openpond.sidebar.continuous-learning.dismissed.v1": "learningNoticeDismissed",
  "openpond.sidebar-task-visibility.v1": "sidebarVisibility",
  "openpond.scheduled-work.view.v1": "scheduledWorkView",
  "openpond.workspace.editorControlsVisible": "editorControlsVisible",
  "openpond.voice.setupNoticeAcknowledged": "voiceNoticeAcknowledged",
  "openpond.post-training-progress.v1": "lessonProgress",
} as const satisfies Record<string, keyof ClientChoices>;
