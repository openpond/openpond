import { ChatAttachmentFilePreviewSchema } from "@openpond/contracts";
import {
  readChatAttachmentImageFile,
  readChatAttachmentTextFile,
} from "../chat-attachments.js";
import { readLocalImageFile, readLocalVideoFile } from "../workspace/workspace-common.js";
import type { HttpRouteDeps } from "./http-route-types.js";

type MediaPayloads = Pick<
  HttpRouteDeps,
  | "localImagePayload"
  | "localVideoPayload"
  | "chatAttachmentImagePayload"
  | "chatAttachmentFilePayload"
>;

export function createMediaPayloads(attachmentRootDir: string, storageHome: string): MediaPayloads {
  return {
    localImagePayload: async (filePath) => {
      const image = await readLocalImageFile(filePath);
      if (!image) throw new Error("Image not found");
      return image;
    },
    localVideoPayload: async (filePath) => {
      const video = await readLocalVideoFile(filePath);
      if (!video) throw new Error("Video not found");
      return video;
    },
    chatAttachmentImagePayload: async (input) => {
      const image = await readChatAttachmentImageFile({
        attachmentRootDir,
        storageHome,
        sessionId: input.sessionId,
        turnId: input.turnId,
        storageName: input.storageName,
        contentType: input.contentType,
      });
      if (!image) throw new Error("Image not found");
      return image;
    },
    chatAttachmentFilePayload: async (payload) => {
      const input = ChatAttachmentFilePreviewSchema.parse(payload);
      const file = await readChatAttachmentTextFile({
        attachmentRootDir,
        storageHome,
        sessionId: input.sessionId,
        turnId: input.turnId,
        storageName: input.storageName,
        contentType: input.contentType,
      });
      if (!file) throw new Error("Attachment preview is unavailable");
      return file;
    },
  };
}
