import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityRulesDialog } from "../apps/web/src/components/community/CommunityRulesDialog";
import { CommunityMessageRow } from "../apps/web/src/components/community/CommunityMessageRow";
import { CollaborationTabs } from "../apps/web/src/components/collaboration/CollaborationTabs";

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

  test("uses one native collaboration switcher for Team Chat and Communities", () => {
    const html = renderToStaticMarkup(createElement(CollaborationTabs, {
      view: "community",
      onSelect: () => undefined,
    }));
    expect(html).toContain('aria-label="Collaboration"');
    expect(html).toContain("Team chat");
    expect(html).toContain("Communities");
    expect(html).toContain('aria-current="page"');
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
