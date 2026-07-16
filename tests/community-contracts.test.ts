import { describe, expect, test } from "vitest";
import {
  CommunityChannelSchema,
  CommunityMessageSchema,
  CommunityPreviewSchema,
} from "@openpond/contracts";

describe("community contracts", () => {
  test("accepts public preview channels with non-member read isolation", () => {
    const channel = CommunityChannelSchema.parse({
      id: "channel_1", communityId: "community_1", chatThreadId: "thread_1", slug: "general",
      displayName: "General", topic: "Welcome", position: 0, visibility: "public_preview",
      postingPolicy: "members", isDefault: true, archivedAt: null, lastMessageSequence: 12,
      unreadCount: 0, readState: null,
    });
    expect(channel.readState).toBeNull();
    expect(channel.lastMessageSequence).toBe(12);
  });

  test("keeps community messages distinct from team messages", () => {
    const message = CommunityMessageSchema.parse({
      id: "message_1", threadId: "thread_1", teamId: null, clientRequestId: "request_1",
      authorType: "user", authorUserId: "user_1", authorAgentId: null, sequence: 1, kind: "text",
      body: "hello", metadata: { mentionUserIds: ["user_2"] }, editedAt: null, deletedAt: null,
      createdAt: "2026-07-15T12:00:00.000Z", refs: [], attachments: [],
    });
    expect(message.teamId).toBeNull();
  });

  test("requires full immutable rules in previews", () => {
    const parsed = CommunityPreviewSchema.safeParse({
      id: "community_1", slug: "openpond", displayName: "OpenPond", description: "Builders",
      imageUrl: null, status: "published", visibility: "public", joinPolicy: "open",
      historyVisibility: "public_preview", featuredAt: null, publishedAt: "2026-07-15T12:00:00.000Z",
      archivedAt: null, memberCount: 2, membership: null,
      capabilities: {
        canPreview: true, canJoin: true, canLeave: false, canRead: true, canPost: false,
        canUpload: false, canMention: false, canManage: false, requiresRulesAcceptance: false,
        currentRulesVersionId: "rules_1",
      },
      currentRules: {
        id: "rules_1", communityId: "community_1", version: 1, title: "Rules",
        bodyMarkdown: "Be kind and help each other.", contentHash: "hash", requiresReacceptance: false,
        publishedAt: "2026-07-15T12:00:00.000Z",
      },
      channels: [], previewMessageLimit: 50,
    });
    expect(parsed.success).toBe(true);
  });
});
