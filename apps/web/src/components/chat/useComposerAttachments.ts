import { useCallback, useEffect, useRef, useState } from "react";
import { CHAT_ATTACHMENT_LIMITS } from "@openpond/contracts";
import {
  composerAttachmentKind,
  createAttachmentId,
  formatBytes,
  type ComposerAttachmentDraft,
} from "./ComposerAttachments";

export function useComposerAttachments() {
  const attachmentsRef = useRef<ComposerAttachmentDraft[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachmentDraft[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      for (const attachment of attachmentsRef.current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;

      const slotsAvailable = Math.max(0, CHAT_ATTACHMENT_LIMITS.maxAttachments - attachments.length);
      const accepted: ComposerAttachmentDraft[] = [];
      let rejectedForSize = 0;
      let skippedForCount = 0;

      for (const file of files) {
        if (file.size > CHAT_ATTACHMENT_LIMITS.maxAttachmentBytes) {
          rejectedForSize += 1;
          continue;
        }
        if (accepted.length >= slotsAvailable) {
          skippedForCount += 1;
          continue;
        }
        accepted.push({
          id: createAttachmentId(),
          file,
          name: file.name || "Untitled file",
          mediaType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          kind: composerAttachmentKind(file),
          ...(file.type.startsWith("image/") ? { previewUrl: URL.createObjectURL(file) } : {}),
        });
      }

      if (accepted.length > 0) {
        setAttachments([...attachments, ...accepted]);
        setAttachmentError(null);
      }

      if (rejectedForSize > 0 || skippedForCount > 0) {
        const messages = [];
        if (rejectedForSize > 0) {
          messages.push(
            `${rejectedForSize} file${rejectedForSize === 1 ? "" : "s"} exceeded ${formatBytes(CHAT_ATTACHMENT_LIMITS.maxAttachmentBytes)}`,
          );
        }
        if (skippedForCount > 0) {
          messages.push(`maximum ${CHAT_ATTACHMENT_LIMITS.maxAttachments} attachments`);
        }
        setAttachmentError(messages.join("; "));
      }
    },
    [attachments],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      const next = current.filter((attachment) => attachment.id !== id);
      if (next.length === 0) setAttachmentError(null);
      return next;
    });
  }, []);

  const clearAttachments = useCallback(() => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    setAttachments([]);
    setAttachmentError(null);
  }, []);

  return {
    attachmentError,
    attachments,
    addFiles,
    clearAttachments,
    removeAttachment,
    setAttachmentError,
  };
}
