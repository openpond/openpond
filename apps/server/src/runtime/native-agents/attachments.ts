import type { AcpObject } from "@openpond/agent-runtime";
import { readChatAttachmentImageFile, type ChatAttachmentContextItem } from "../../chat-attachments.js";

export async function nativeImageContent(input: { storageHome: string; attachmentRootDir: string; sessionId: string; turnId: string; attachments: ChatAttachmentContextItem[] }): Promise<AcpObject[]> {
  const content: AcpObject[] = [];
  let bytes = 0;
  for (const attachment of input.attachments) {
    if (!attachment.storageName || !attachment.mediaType.startsWith("image/")) continue;
    const image = await readChatAttachmentImageFile({ ...input, storageName: attachment.storageName, contentType: attachment.mediaType });
    if (!image) throw new Error("This image attachment cannot be read by the native agent.");
    bytes += image.sizeBytes;
    if (bytes > 5 * 1024 * 1024) throw new Error("Native agent image input is limited to 5 MiB per turn. Reduce the image size and retry.");
    content.push({ type: "image", mimeType: image.contentType, data: image.bytes.toString("base64") });
  }
  return content;
}
