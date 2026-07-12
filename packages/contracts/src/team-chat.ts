import { z } from "zod";

const MetadataSchema = z.record(z.string(), z.unknown());

export const TeamChatMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(["owner", "admin", "member"]),
  name: z.string(),
  handle: z.string().nullable(),
  image: z.string().nullable(),
});

export type TeamChatAgentCatalogEntry = {
  id: string;
  name: string;
  label: string;
  description: string | null;
  inputSchema: string | null;
  setupRequirements: Record<string, unknown>[];
  implementation: {
    type: "openpond-agent";
    agentId: string;
    agentName: string;
    actionId: string;
    profileProjectId: string;
    profileName: string;
  };
  invokesModel: boolean;
  approvalPolicy: {
    required: boolean;
    risk: "read" | "write" | "destructive";
  };
};

export type TeamChatAgentRunResult = {
  message: TeamChatMessage;
  conversationId: string;
  idempotentReplay: boolean;
  agent: { id: string; name: string } & Record<string, unknown>;
  run: { id: string; status: string; metadata: Record<string, unknown> } & Record<
    string,
    unknown
  >;
};

export type TeamChatAgentConversation = {
  conversationId: string;
  teamId: string;
  title: string | null;
  agent: { id: string; name: string; slug: string };
  run: TeamChatAgentRunResult["run"];
  messages: Array<{
    id: string;
    sequence: number;
    role: "user" | "assistant" | "system" | "action";
    body: string;
    createdByUserId: string | null;
    createdAt: string;
  }>;
  pinnedRouting: Record<string, unknown>;
};

export const TeamChatParticipantSchema = z.object({
  userId: z.string(),
  role: z.enum(["owner", "admin", "member"]),
  name: z.string(),
  handle: z.string().nullable(),
  image: z.string().nullable(),
  lastReadSequence: z.number().int().nonnegative(),
});

export const TeamChatMessageRefSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  refType: z.enum([
    "hosted_ai_thread",
    "coding_work_item",
    "goal",
    "openpond_session",
    "project",
    "agent_run",
  ]),
  refId: z.string(),
  preview: MetadataSchema,
  createdAt: z.string(),
});

export const TeamChatAttachmentSchema = z.object({
  id: z.string(),
  messageId: z.string().nullable(),
  clientAttachmentId: z.string(),
  kind: z.literal("image"),
  name: z.string(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  sizeBytes: z.number().int().positive(),
  status: z.enum(["pending", "ready", "failed"]),
  createdAt: z.string(),
  readyAt: z.string().nullable(),
});

export const TeamChatAttachmentUploadSchema = z.object({
  attachment: TeamChatAttachmentSchema,
  uploadUrl: z.string().url().nullable(),
  uploadHeaders: z.record(z.string(), z.string()),
  expiresAt: z.string().nullable(),
});

export const TeamChatAttachmentDownloadSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string(),
});

export const TeamChatMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  teamId: z.string(),
  clientRequestId: z.string().nullable(),
  authorType: z.enum(["user", "agent", "system"]),
  authorUserId: z.string().nullable(),
  authorAgentId: z.string().nullable(),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(["text", "system", "command_result", "work_item_card"]),
  body: z.string(),
  metadata: MetadataSchema,
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  refs: z.array(TeamChatMessageRefSchema),
  attachments: z.array(TeamChatAttachmentSchema),
});

export const TeamChatThreadSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  kind: z.enum(["general", "dm", "group", "channel"]),
  title: z.string().nullable(),
  createdByUserId: z.string(),
  lastMessageId: z.string().nullable(),
  lastMessageSequence: z.number().int().nonnegative(),
  lastMessageAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  unreadCount: z.number().int().nonnegative(),
  pinnedAt: z.string().nullable(),
  mutedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  participants: z.array(TeamChatParticipantSchema),
  lastMessage: TeamChatMessageSchema.nullable(),
});

export const TeamChatThreadDetailSchema = z.object({
  thread: TeamChatThreadSchema,
  messages: z.array(TeamChatMessageSchema),
  hasMoreBefore: z.boolean(),
});

export const TeamChatAiTurnStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

export const TeamChatAiTurnSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  threadId: z.string(),
  teamId: z.string(),
  requestedByUserId: z.string(),
  executorUserId: z.string().nullable(),
  providerId: z.string(),
  modelId: z.string(),
  clientRequestId: z.string(),
  baseMessageSequence: z.number().int().nonnegative(),
  status: TeamChatAiTurnStatusSchema,
  partialBody: z.string().nullable(),
  userMessageId: z.string(),
  assistantMessageId: z.string().nullable(),
  errorCode: z.string().nullable(),
  cancelledByUserId: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const TeamChatAiMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  sequence: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system", "action"]),
  body: z.string(),
  createdByUserId: z.string().nullable(),
  createdAt: z.string(),
});

export const TeamChatHostedAiThreadSchema = z.object({
  conversationId: z.string(),
  parentThreadId: z.string(),
  parentMessageId: z.string(),
  teamId: z.string(),
  title: z.string().nullable(),
  providerId: z.string().nullable(),
  modelId: z.string(),
  createdByUserId: z.string(),
  messages: z.array(TeamChatAiMessageSchema),
  turns: z.array(TeamChatAiTurnSchema),
  activeTurn: TeamChatAiTurnSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const TeamChatEventSchema = z.object({
  id: z.number().int().nonnegative(),
  teamId: z.string(),
  threadId: z.string(),
  conversationId: z.string().nullable(),
  type: z.enum([
    "thread.created",
    "message.created",
    "message.updated",
    "message.deleted",
    "read.updated",
    "ai_thread.created",
    "ai_turn.updated",
  ]),
  payload: MetadataSchema,
  createdAt: z.string(),
});

export const TeamChatEventPageSchema = z.object({
  events: z.array(TeamChatEventSchema),
  cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export const TeamChatRealtimeSessionSchema = z.object({
  httpUrl: z.string().min(1),
  realtimeUrl: z.string().min(1),
  region: z.string().min(1),
  token: z.string().min(1),
  expiresAt: z.string().min(1),
  teamId: z.string().min(1),
  userId: z.string().min(1),
});

export type TeamChatMember = z.infer<typeof TeamChatMemberSchema>;
export type TeamChatParticipant = z.infer<typeof TeamChatParticipantSchema>;
export type TeamChatMessageRef = z.infer<typeof TeamChatMessageRefSchema>;
export type TeamChatAttachment = z.infer<typeof TeamChatAttachmentSchema>;
export type TeamChatAttachmentUpload = z.infer<typeof TeamChatAttachmentUploadSchema>;
export type TeamChatAttachmentDownload = z.infer<typeof TeamChatAttachmentDownloadSchema>;
export type TeamChatMessage = z.infer<typeof TeamChatMessageSchema>;
export type TeamChatThread = z.infer<typeof TeamChatThreadSchema>;
export type TeamChatThreadDetail = z.infer<typeof TeamChatThreadDetailSchema>;
export type TeamChatAiTurnStatus = z.infer<typeof TeamChatAiTurnStatusSchema>;
export type TeamChatAiTurn = z.infer<typeof TeamChatAiTurnSchema>;
export type TeamChatAiMessage = z.infer<typeof TeamChatAiMessageSchema>;
export type TeamChatHostedAiThread = z.infer<typeof TeamChatHostedAiThreadSchema>;
export type TeamChatEvent = z.infer<typeof TeamChatEventSchema>;
export type TeamChatEventPage = z.infer<typeof TeamChatEventPageSchema>;
export type TeamChatRealtimeSession = z.infer<typeof TeamChatRealtimeSessionSchema>;
