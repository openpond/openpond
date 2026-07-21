import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityRulesDialog } from "../apps/web/src/components/community/CommunityRulesDialog";
import { CommunityComposer } from "../apps/web/src/components/community/CommunityComposer";
import { CommunityMessageRow } from "../apps/web/src/components/community/CommunityMessageRow";
import { SidebarCommunitySection } from "../apps/web/src/components/sidebar/SidebarCommunitySection";

describe("community UI", () => {
  test("requires an explicit rules agreement before join", () => {
    const html = renderToStaticMarkup(createElement(CommunityRulesDialog, {
      rules: {
        id: "rules_1", communityId: "community_1", version: 1, title: "Community rules",
        bodyMarkdown: "Be kind and stay on topic.", contentHash: "hash", requiresReacceptance: false,
        publishedAt: "2026-07-15T12:00:00.000Z",
      },
      mode: "join",
      busy: false,
      error: null,
      onAccept: async () => true,
      onClose: () => undefined,
    }));
    expect(html).toContain("I have read and agree");
    expect(html).toContain("Agree and join");
    expect(html).toMatch(/disabled=""[^>]*>Agree and join/);
  });

  test("renders joined channels with unread and mute state in the desktop sidebar", () => {
    const html = renderToStaticMarkup(createElement(SidebarCommunitySection, {
      communities: [{
        id: "community_1", slug: "openpond", displayName: "OpenPond", description: "Builders",
        imageUrl: null, status: "published", visibility: "public", joinPolicy: "open",
        historyVisibility: "public_preview", featuredAt: "2026-07-15T12:00:00.000Z",
        publishedAt: "2026-07-15T12:00:00.000Z", archivedAt: null, memberCount: 10,
        membership: { role: "member", status: "active", notificationMode: "mentions" },
        capabilities: {
          canPreview: true, canJoin: false, canLeave: true, canRead: true, canPost: true,
          canUpload: true, canMention: true, canManage: false, requiresRulesAcceptance: false,
          currentRulesVersionId: "rules_1",
        },
        currentRules: {
          id: "rules_1", communityId: "community_1", version: 1, title: "Rules",
          requiresReacceptance: false, publishedAt: "2026-07-15T12:00:00.000Z",
        },
      }],
      channels: [{
        id: "channel_1", communityId: "community_1", chatThreadId: "thread_1", slug: "general",
        displayName: "general", topic: "Talk", position: 0, visibility: "public_preview",
        postingPolicy: "members", isDefault: true, archivedAt: null, lastMessageSequence: 8,
        unreadCount: 3,
        readState: { lastReadSequence: 5, lastReadAt: null, mutedAt: "2026-07-15T12:00:00.000Z", pinnedAt: null },
      }],
      loading: false, error: null, selectedCommunityId: "community_1", selectedChannelId: "channel_1",
      view: "community", onDiscover: () => undefined, onSelectCommunity: () => undefined, onSelectChannel: () => undefined,
    }));
    expect(html).toContain("Discover communities");
    expect(html).toContain('aria-label="Collapse Communities"');
    expect(html).toContain("general");
    expect(html).toContain("3 unread");
    expect(html).toContain("Muted");
    expect(html).toContain("team-sidebar-row community-sidebar-community");
    expect(html).toContain('aria-label="Collapse OpenPond"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="community-sidebar-channels-community_1"');
    expect(html).toContain("team-sidebar-row community-sidebar-channel-row selected");
    expect(html).toContain("team-sidebar-unread");
  });

  test("uses the same dock composer surface as Team Chat", () => {
    const html = renderToStaticMarkup(createElement(CommunityComposer, {
      members: [],
      replyTo: null,
      busy: false,
      disabled: false,
      onCancelReply: () => undefined,
      onSearchMembers: async () => [],
      onSend: async () => true,
    }));
    expect(html).toContain('class="composer dock community-composer"');
    expect(html).toContain('class="composer-textarea-frame"');
    expect(html).toContain('class="composer-inline-input"');
    expect(html).toContain('class="composer-primary-controls team-chat-composer-controls"');
    expect(html).toContain('class="send-button"');
    expect(html).not.toContain("<textarea");
  });

  test("keeps community chat in a full-height Team-style conversation shell", async () => {
    const [mainPaneControls, communityView, communityCss, sidebarCss, conversationCss] = await Promise.all([
      readFile("apps/web/src/components/app-shell/MainPaneControls.tsx", "utf8"),
      readFile("apps/web/src/components/community/CommunityView.tsx", "utf8"),
      readFile("apps/web/src/styles/community/community.css", "utf8"),
      readFile("apps/web/src/styles/sidebar/community-sidebar.css", "utf8"),
      readFile("apps/web/src/styles/chat/conversation-surface.css", "utf8"),
    ]);
    expect(mainPaneControls).toContain('if (view === "community") return "community-active"');
    expect(communityView).toContain('community-chat-main conversation-surface-main');
    expect(communityView).toContain('community-message-pane conversation-message-scroll');
    expect(communityView).toContain('community-composer-wrap conversation-composer-shell');
    expect(communityCss).toContain(".main-pane.community-active");
    expect(communityCss).toContain("--conversation-surface-rows: auto minmax(0, 1fr) auto");
    expect(conversationCss).toContain("grid-template-rows: var(--conversation-surface-rows");
    expect(sidebarCss).toContain("font-size: 13px");
    expect(`${communityCss}\n${sidebarCss}`).not.toContain("#6366f1");
  });

  test("shows attachment placeholders instead of download controls before joining", () => {
    const message = {
      id: "message_1", threadId: "thread_1", teamId: null, clientRequestId: null,
      authorType: "user" as const, authorUserId: "user_1", authorAgentId: null,
      sequence: 1, kind: "text" as const, body: "Preview message", metadata: {},
      editedAt: null, deletedAt: null, createdAt: "2026-07-15T12:00:00.000Z", refs: [],
      attachments: [{
        id: "attachment_1", messageId: "message_1", clientAttachmentId: "client_1",
        kind: "image" as const, name: "preview.png", mediaType: "image/png" as const,
        sizeBytes: 1024, status: "ready" as const,
        createdAt: "2026-07-15T12:00:00.000Z", readyAt: "2026-07-15T12:00:00.000Z",
      }],
    };
    const html = renderToStaticMarkup(createElement(CommunityMessageRow, {
      message,
      author: null,
      own: false,
      attachmentsAccessible: false,
      messagesById: new Map(),
      membersById: new Map(),
      onReply: () => undefined,
      onEdit: async () => false,
      onDelete: async () => false,
      onDownloadAttachment: async () => false,
    }));
    expect(html).toContain("Join to view");
    expect(html).not.toContain('<button type="button"><span>preview.png');
  });
});
