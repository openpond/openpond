import { randomUUID } from "node:crypto";
import { ChatAttachmentSchema, CHAT_ATTACHMENT_LIMITS, SendTurnRequestSchema, type SendTurnRequest } from "@openpond/contracts/requests";
import { RequestError, type ContentBlock } from "@agentclientprotocol/sdk";

/** Embedded content is context. Resource links are never implicitly read from disk/network. */
export function promptInput(content: ContentBlock[]): SendTurnRequest {
  const text: string[] = [];
  const attachments: NonNullable<SendTurnRequest["attachments"]> = [];
  for (const block of content) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "resource" && "text" in block.resource) {
      text.push(`[Context: ${block.resource.uri}]\n${block.resource.text}`);
    } else if (block.type === "resource_link") {
      text.push(`[Resource: ${block.name}] ${block.uri}${block.description ? `\n${block.description}` : ""}`);
    } else if (block.type === "image") {
      if (!block.mimeType.startsWith("image/") || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data)) {
        throw RequestError.invalidParams(undefined, "Invalid image content.");
      }
      if (block.data.length > CHAT_ATTACHMENT_LIMITS.maxAttachmentBase64Chars) throw RequestError.invalidParams(undefined, "Image exceeds attachment limit.");
      attachments.push(ChatAttachmentSchema.parse({ id: randomUUID(), name: "ACP image", kind: "image", mediaType: block.mimeType, sizeBytes: Buffer.from(block.data, "base64").length, contentsBase64: block.data }));
    } else throw RequestError.invalidParams(undefined, `Unsupported ACP content: ${block.type}. Supply text, images or embedded text resources.`);
  }
  const prompt = text.join("\n\n");
  if (prompt.length > CHAT_ATTACHMENT_LIMITS.maxTextChars || attachments.length > CHAT_ATTACHMENT_LIMITS.maxAttachments) throw RequestError.invalidParams(undefined, "Prompt exceeds content limits.");
  if (!prompt.trim() && !attachments.length) throw RequestError.invalidParams(undefined, "Prompt is empty.");
  return SendTurnRequestSchema.parse({ prompt: prompt.trim() || "Please inspect the attached image.", attachments });
}
