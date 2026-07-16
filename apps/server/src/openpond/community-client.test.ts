import { describe, expect, vi, test } from "vitest";
import { CommunityApiError, communityRequestPayload } from "./community-client.js";

describe("community hosted client", () => {
  test("forwards discovery and exact rules acceptance to the hosted API", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = mockFetch(async (url, init) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/join")) return Response.json({ membership: membership(), channels: [channel()] });
      return Response.json({ items: [summary()], nextCursor: null });
    });
    await communityRequestPayload({ type: "discover" }, { fetchImpl, loadAccountContext: testAccountContext });
    const joined = await communityRequestPayload(
      { type: "join", communityId: "community_1", acceptedRulesVersionId: "rules_2" },
      { fetchImpl, loadAccountContext: testAccountContext },
    );
    expect(requests).toEqual([
      { url: "https://api.test/v1/communities", body: null },
      {
        url: "https://api.test/v1/communities/community_1/join",
        body: { acceptedRulesVersionId: "rules_2", accepted: true },
      },
    ]);
    expect(joined).toMatchObject({ channels: [{ id: "channel_1", unreadCount: 3 }] });
  });

  test("preserves stable community error codes and details", async () => {
    const fetchImpl = mockFetch(async () => Response.json(
      { error: "community_rules_version_stale", details: { currentRulesVersionId: "rules_3" } },
      { status: 409 },
    ));
    try {
      await communityRequestPayload(
        { type: "join", communityId: "community_1", acceptedRulesVersionId: "rules_2" },
        { fetchImpl, loadAccountContext: testAccountContext },
      );
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CommunityApiError);
      expect(error).toMatchObject({
        code: "community_rules_version_stale",
        status: 409,
        details: { currentRulesVersionId: "rules_3" },
      });
    }
  });

  test("coordinates an authorized community attachment upload", async () => {
    const urls: string[] = [];
    const fetchImpl = mockFetch(async (url, init) => {
      urls.push(url);
      if (url.endsWith("/attachments")) return Response.json({
        attachment: attachment("pending"),
        uploadUrl: "https://upload.test/community-image",
        uploadHeaders: { "content-type": "image/png" },
        expiresAt: "2026-07-15T12:05:00.000Z",
      });
      if (url === "https://upload.test/community-image") {
        expect(Buffer.from(init?.body as Uint8Array)).toEqual(Buffer.from([1, 2, 3]));
        return new Response(null, { status: 200 });
      }
      return Response.json(attachment("ready"));
    });
    const result = await communityRequestPayload({
      type: "attachment_upload",
      communityId: "community_1",
      channelId: "channel_1",
      attachment: {
        id: "client_attachment_1",
        name: "image.png",
        mediaType: "image/png",
        sizeBytes: 3,
        kind: "image",
        contentsBase64: Buffer.from([1, 2, 3]).toString("base64"),
      },
    }, { fetchImpl, loadAccountContext: testAccountContext });
    expect(result).toMatchObject({ id: "attachment_1", status: "ready" });
    expect(urls).toEqual([
      "https://api.test/v1/communities/community_1/channels/channel_1/attachments",
      "https://upload.test/community-image",
      "https://api.test/v1/communities/community_1/channels/channel_1/attachments/attachment_1/finalize",
    ]);
  });
});

function summary() {
  return {
    id: "community_1", slug: "openpond", displayName: "OpenPond", description: "Builders",
    imageUrl: null, status: "published", visibility: "public", joinPolicy: "open",
    historyVisibility: "public_preview", featuredAt: null, publishedAt: "2026-07-15T12:00:00.000Z",
    archivedAt: null, memberCount: 4, membership: null,
    capabilities: {
      canPreview: true, canJoin: true, canLeave: false, canRead: true, canPost: false,
      canUpload: false, canMention: false, canManage: false, requiresRulesAcceptance: false,
      currentRulesVersionId: "rules_2",
    },
    currentRules: {
      id: "rules_2", communityId: "community_1", version: 2, title: "Be kind",
      requiresReacceptance: false, publishedAt: "2026-07-15T12:00:00.000Z",
    },
  };
}

function channel() {
  return {
    id: "channel_1", communityId: "community_1", chatThreadId: "thread_1", slug: "general",
    displayName: "general", topic: "Talk", position: 0, visibility: "public_preview",
    postingPolicy: "members", isDefault: true, archivedAt: null, lastMessageSequence: 8,
    unreadCount: 3,
    readState: { lastReadSequence: 5, lastReadAt: null, mutedAt: null, pinnedAt: null },
  };
}

function membership() {
  return {
    id: "membership_1", communityId: "community_1", userId: "user_1", role: "member",
    status: "active", notificationMode: "mentions", joinedAt: "2026-07-15T12:00:00.000Z",
    leftAt: null, createdAt: "2026-07-15T12:00:00.000Z", updatedAt: "2026-07-15T12:00:00.000Z",
  };
}

function attachment(status: "pending" | "ready") {
  return {
    id: "attachment_1", messageId: null, clientAttachmentId: "client_attachment_1", kind: "image",
    name: "image.png", mediaType: "image/png", sizeBytes: 3, status,
    createdAt: "2026-07-15T12:00:00.000Z", readyAt: status === "ready" ? "2026-07-15T12:00:01.000Z" : null,
  };
}

function mockFetch(implementation: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => implementation(String(input), init)) as unknown as typeof fetch;
}

async function testAccountContext() {
  return { config: {}, profiles: [], account: null, token: "opk_test", apiBaseUrl: "https://api.test", chatApiBaseUrl: "https://api.test", accountState: {} as never };
}
