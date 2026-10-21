import { createHash } from "node:crypto";
import { ChatAttachmentSchema, type ChatAttachment } from "@openpond/contracts/requests";
import type { TaskInput } from "@openpond/contracts/task-inbox";
import { chatAttachmentContext, chatAttachmentSummaries, materializeChatAttachments, type ChatAttachmentContextItem } from "../../chat-attachments.js";

export function taskInputAttachments(input: TaskInput): ChatAttachment[] {
  return ChatAttachmentSchema.array().parse(input.payload.attachments ?? []);
}

export function taskInputImages(input: TaskInput): Array<{ url: string }> {
  return taskInputAttachments(input).flatMap(attachment => attachment.kind === "image" && attachment.contentsBase64
    ? [{ url: `data:${attachment.mediaType};base64,${attachment.contentsBase64}` }] : []);
}

/** Keep binary files out of prompts and retain stable, readable paths across requests/restarts. */
export function createTaskInputAttachmentPreparation(config: { storageHome: string; attachmentRootDir: string }) {
  const prepared = new Map<string, Promise<ChatAttachmentContextItem[]>>();
  return async (input: TaskInput): Promise<TaskInput> => {
    const attachments = taskInputAttachments(input);
    if (!attachments.length) return input;
    if (!input.turnId) throw new Error("Attachments require an assigned task turn before delivery.");
    const identity = createHash("sha256").update(input.id).digest("hex");
    const key = `${input.turnId}:${identity}`;
    let pending = prepared.get(key);
    if (!pending) {
      pending = materializeChatAttachments({ ...config, sessionId: input.sessionId, turnId: input.turnId,
        attachments: attachments.map(attachment => ({ ...attachment,
          relativePath: `steering/${identity}/${attachment.relativePath ?? attachment.name}` })),
      });
      prepared.set(key, pending);
      if (prepared.size > 128) prepared.delete(prepared.keys().next().value!);
      pending.catch(() => { if (prepared.get(key) === pending) prepared.delete(key); });
    }
    const contexts = await pending;
    return { ...input, payload: { ...input.payload, attachmentContext: chatAttachmentContext(contexts),
      attachmentSummaries: chatAttachmentSummaries(attachments, { sessionId: input.sessionId, turnId: input.turnId, materialized: contexts }),
    } };
  };
}
