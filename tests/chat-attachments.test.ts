import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ChatAttachment } from "@openpond/contracts";
import {
  chatAttachmentSummaries,
  materializeChatAttachments,
  readChatAttachmentTextFile,
} from "../apps/server/src/chat-attachments";

describe("chat attachment file previews", () => {
  test("exposes and reads stored text attachments without exposing image files as text", async () => {
    const attachmentRootDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-chat-attachments-"),
    );
    const attachments: ChatAttachment[] = [
      {
        id: "notes",
        kind: "text",
        mediaType: "text/markdown",
        name: "notes.md",
        sizeBytes: 13,
        text: "# Test notes\n",
        contentsBase64: Buffer.from("# Test notes\n").toString("base64"),
      },
      {
        id: "image",
        kind: "image",
        mediaType: "image/png",
        name: "screen.png",
        sizeBytes: 4,
        contentsBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
      },
    ];

    try {
      const materialized = await materializeChatAttachments({
        attachmentRootDir,
        sessionId: "session-1",
        turnId: "turn-1",
        attachments,
      });
      const summaries = chatAttachmentSummaries(attachments, {
        sessionId: "session-1",
        turnId: "turn-1",
        materialized,
      });

      expect(summaries[0]?.filePreview).toMatchObject({
        attachmentId: "notes",
        storageName: "notes.md",
        contentType: "text/markdown",
      });
      expect(summaries[0]?.lineCount).toBe(1);
      expect(summaries[1]?.filePreview).toBeUndefined();
      expect(summaries[1]?.imagePreview).toMatchObject({
        attachmentId: "image",
        storageName: "screen.png",
        contentType: "image/png",
      });

      const preview = await readChatAttachmentTextFile({
        attachmentRootDir,
        sessionId: "session-1",
        turnId: "turn-1",
        storageName: "notes.md",
        contentType: "text/markdown",
      });
      expect(preview).toMatchObject({
        path: "notes.md",
        contentType: "text/markdown",
        content: "# Test notes\n",
        sizeBytes: 13,
      });
    } finally {
      await rm(attachmentRootDir, { recursive: true, force: true });
    }
  });

  test("rejects traversal and non-text preview requests", async () => {
    const attachmentRootDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-chat-attachments-"),
    );
    try {
      await expect(
        readChatAttachmentTextFile({
          attachmentRootDir,
          sessionId: "session-1",
          turnId: "turn-1",
          storageName: "../outside.txt",
          contentType: "text/plain",
        }),
      ).resolves.toBeNull();
      await expect(
        readChatAttachmentTextFile({
          attachmentRootDir,
          sessionId: "session-1",
          turnId: "turn-1",
          storageName: "screen.png",
          contentType: "image/png",
        }),
      ).resolves.toBeNull();
    } finally {
      await rm(attachmentRootDir, { recursive: true, force: true });
    }
  });
});
