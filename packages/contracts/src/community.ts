import { z } from "zod";

const MetadataSchema = z.record(z.string(), z.unknown());
const NullableTimestampSchema = z.string().nullable();

export const CommunityStatusSchema = z.enum(["draft", "published", "archived"]);
export const CommunityRoleSchema = z.enum(["owner", "admin", "member"]);
export const CommunityMembershipStatusSchema = z.enum(["active", "left"]);
export const CommunityNotificationModeSchema = z.enum(["mentions", "all", "none"]);
export const CommunityChannelVisibilitySchema = z.enum(["public_preview", "members"]);
export const CommunityChannelPostingPolicySchema = z.enum(["members", "admins"]);

export const CommunityCapabilitiesSchema = z.object({
  canPreview: z.boolean(),
  canJoin: z.boolean(),
  canLeave: z.boolean(),
  canRead: z.boolean(),
  canPost: z.boolean(),
  canUpload: z.boolean(),
  canMention: z.boolean(),
  canManage: z.boolean(),
  requiresRulesAcceptance: z.boolean(),
  currentRulesVersionId: z.string().nullable(),
});

export const CommunityRuleSummarySchema = z.object({
  id: z.string(),
  communityId: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  requiresReacceptance: z.boolean(),
  publishedAt: z.string(),
});

export const CommunityRuleVersionSchema = CommunityRuleSummarySchema.extend({
  bodyMarkdown: z.string(),
  contentHash: z.string(),
});

export const CommunityMembershipSummarySchema = z.object({
  role: CommunityRoleSchema,
  status: CommunityMembershipStatusSchema,
  notificationMode: CommunityNotificationModeSchema,
});

export const CommunityMembershipSchema = z.object({
  id: z.string(),
  communityId: z.string(),
  userId: z.string(),
  role: CommunityRoleSchema,
  status: CommunityMembershipStatusSchema,
  notificationMode: CommunityNotificationModeSchema,
  joinedAt: z.string(),
  leftAt: NullableTimestampSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CommunitySummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  imageUrl: z.string().nullable(),
  status: CommunityStatusSchema,
  visibility: z.enum(["public", "private"]),
  joinPolicy: z.enum(["open", "closed"]),
  historyVisibility: CommunityChannelVisibilitySchema,
  featuredAt: NullableTimestampSchema,
  publishedAt: NullableTimestampSchema,
  archivedAt: NullableTimestampSchema,
  memberCount: z.number().int().nonnegative(),
  membership: CommunityMembershipSummarySchema.nullable(),
  capabilities: CommunityCapabilitiesSchema,
  currentRules: CommunityRuleSummarySchema.nullable(),
});

export const CommunityDiscoveryPageSchema = z.object({
  items: z.array(CommunitySummarySchema),
  nextCursor: z.string().nullable(),
});

export const CommunityChannelReadStateSchema = z.object({
  lastReadSequence: z.number().int().nonnegative(),
  lastReadAt: NullableTimestampSchema.optional(),
  mutedAt: NullableTimestampSchema,
  pinnedAt: NullableTimestampSchema,
});

export const CommunityChannelSchema = z.object({
  id: z.string(),
  communityId: z.string(),
  chatThreadId: z.string().nullable(),
  slug: z.string(),
  displayName: z.string(),
  topic: z.string(),
  position: z.number().int().nonnegative(),
  visibility: CommunityChannelVisibilitySchema,
  postingPolicy: CommunityChannelPostingPolicySchema,
  isDefault: z.boolean(),
  archivedAt: NullableTimestampSchema,
  lastMessageSequence: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
  readState: CommunityChannelReadStateSchema.nullable(),
});

export const CommunityPreviewSchema = CommunitySummarySchema.omit({ currentRules: true }).extend({
  currentRules: CommunityRuleVersionSchema.nullable(),
  channels: z.array(CommunityChannelSchema),
  previewMessageLimit: z.number().int().positive(),
});

export const CommunityMessageRefSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  refType: z.enum([
    "hosted_ai_thread",
    "coding_work_item",
    "goal",
    "openpond_session",
    "project",
    "agent_run",
    "message_reply",
  ]),
  refId: z.string(),
  preview: MetadataSchema,
  createdAt: z.string(),
});

export const CommunityAttachmentSchema = z.object({
  id: z.string(),
  messageId: z.string().nullable(),
  clientAttachmentId: z.string(),
  kind: z.literal("image"),
  name: z.string(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  sizeBytes: z.number().int().positive(),
  status: z.enum(["pending", "ready", "failed"]),
  createdAt: z.string(),
  readyAt: NullableTimestampSchema,
});

export const CommunityAttachmentUploadSchema = z.object({
  attachment: CommunityAttachmentSchema,
  uploadUrl: z.string().url().nullable(),
  uploadHeaders: z.record(z.string(), z.string()),
  expiresAt: NullableTimestampSchema,
});

export const CommunityAttachmentDownloadSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string(),
});

export const CommunityMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  teamId: z.null(),
  clientRequestId: z.string().nullable(),
  authorType: z.enum(["user", "agent", "system"]),
  authorUserId: z.string().nullable(),
  authorAgentId: z.string().nullable(),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(["text", "system", "command_result", "work_item_card"]),
  body: z.string(),
  metadata: MetadataSchema,
  editedAt: NullableTimestampSchema,
  deletedAt: NullableTimestampSchema,
  createdAt: z.string(),
  refs: z.array(CommunityMessageRefSchema),
  attachments: z.array(CommunityAttachmentSchema),
});

export const CommunityChannelMessagePageSchema = z.object({
  messages: z.array(CommunityMessageSchema),
  hasMoreBefore: z.boolean(),
  channelId: z.string(),
  readState: CommunityChannelReadStateSchema.omit({ lastReadAt: true }).nullable(),
  preview: z.boolean(),
});

export const CommunityMemberSchema = z.object({
  userId: z.string(),
  handle: z.string().nullable(),
  name: z.string().nullable(),
  role: CommunityRoleSchema,
});

export const CommunityMemberSearchResultSchema = z.object({
  items: z.array(CommunityMemberSchema),
  nextCursor: z.string().nullable(),
});

export const CommunityEventSchema = z.object({
  id: z.number().int().nonnegative(),
  communityId: z.string(),
  channelId: z.string(),
  threadId: z.string(),
  type: z.enum([
    "thread.created",
    "message.created",
    "message.updated",
    "message.deleted",
    "read.updated",
  ]),
  payload: MetadataSchema,
  createdAt: z.string(),
});

export const CommunityEventPageSchema = z.object({
  events: z.array(CommunityEventSchema),
  cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export const CommunityRealtimeSessionSchema = z.object({
  httpUrl: z.string().min(1),
  realtimeUrl: z.string().min(1),
  region: z.string().min(1),
  token: z.string().min(1),
  expiresAt: z.string().min(1),
  communityId: z.string().min(1),
  userId: z.string().min(1),
  channel: z.string().min(1),
});

export const CommunityJoinResultSchema = z.object({
  membership: CommunityMembershipSchema,
  channels: z.array(CommunityChannelSchema),
});

export const CommunityChannelsResultSchema = z.object({
  channels: z.array(CommunityChannelSchema),
});

export type CommunityStatus = z.infer<typeof CommunityStatusSchema>;
export type CommunityRole = z.infer<typeof CommunityRoleSchema>;
export type CommunityNotificationMode = z.infer<typeof CommunityNotificationModeSchema>;
export type CommunityCapabilities = z.infer<typeof CommunityCapabilitiesSchema>;
export type CommunityRuleSummary = z.infer<typeof CommunityRuleSummarySchema>;
export type CommunityRuleVersion = z.infer<typeof CommunityRuleVersionSchema>;
export type CommunityMembershipSummary = z.infer<typeof CommunityMembershipSummarySchema>;
export type CommunityMembership = z.infer<typeof CommunityMembershipSchema>;
export type CommunitySummary = z.infer<typeof CommunitySummarySchema>;
export type CommunityDiscoveryPage = z.infer<typeof CommunityDiscoveryPageSchema>;
export type CommunityChannelReadState = z.infer<typeof CommunityChannelReadStateSchema>;
export type CommunityChannel = z.infer<typeof CommunityChannelSchema>;
export type CommunityPreview = z.infer<typeof CommunityPreviewSchema>;
export type CommunityMessageRef = z.infer<typeof CommunityMessageRefSchema>;
export type CommunityAttachment = z.infer<typeof CommunityAttachmentSchema>;
export type CommunityAttachmentUpload = z.infer<typeof CommunityAttachmentUploadSchema>;
export type CommunityAttachmentDownload = z.infer<typeof CommunityAttachmentDownloadSchema>;
export type CommunityMessage = z.infer<typeof CommunityMessageSchema>;
export type CommunityChannelMessagePage = z.infer<typeof CommunityChannelMessagePageSchema>;
export type CommunityMember = z.infer<typeof CommunityMemberSchema>;
export type CommunityMemberSearchResult = z.infer<typeof CommunityMemberSearchResultSchema>;
export type CommunityEvent = z.infer<typeof CommunityEventSchema>;
export type CommunityEventPage = z.infer<typeof CommunityEventPageSchema>;
export type CommunityRealtimeSession = z.infer<typeof CommunityRealtimeSessionSchema>;
export type CommunityJoinResult = z.infer<typeof CommunityJoinResultSchema>;
