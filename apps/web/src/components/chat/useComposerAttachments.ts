import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createComposerAttachmentStore, scopedComposerAttachmentStore } from "./composer-attachment-store";
import { CHAT_ATTACHMENT_LIMITS, type ChatAttachment } from "@openpond/contracts";
import {
  composerAttachmentKind,
  createAttachmentId,
  formatBytes,
  type ComposerAttachmentDraft,
  readComposerAttachmentPayload,
} from "./ComposerAttachments";

export function useComposerAttachments(owner?: object, scope = "composer") {
  const localStore = useRef<ReturnType<typeof createComposerAttachmentStore> | null>(null);
  if (!localStore.current) localStore.current = createComposerAttachmentStore();
  const store = useMemo(() => owner ? scopedComposerAttachmentStore(owner, scope) : localStore.current!, [owner, scope]);
  const unmountedRef = useRef(false);
  const attachments = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0 || unmountedRef.current) return;
      const current = store.getSnapshot();

      const slotsAvailable = Math.max(
        0,
        CHAT_ATTACHMENT_LIMITS.maxAttachments - current.length
      );
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
        const relativePath =
          "webkitRelativePath" in file &&
          typeof file.webkitRelativePath === "string" &&
          file.webkitRelativePath.trim()
            ? file.webkitRelativePath.trim()
            : undefined;
        accepted.push({
          id: createAttachmentId(),
          file,
          name: file.name || "Untitled file",
          mediaType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          kind: composerAttachmentKind(file),
          ...(relativePath ? { relativePath } : {}),
        });
      }

      if (accepted.length > 0) {
        const next = [...current, ...accepted];
        store.update(next);
        setAttachmentError(null);
      }

      if (rejectedForSize > 0 || skippedForCount > 0) {
        const messages = [];
        if (rejectedForSize > 0) {
          messages.push(
            `${rejectedForSize} file${
              rejectedForSize === 1 ? "" : "s"
            } exceeded ${formatBytes(
              CHAT_ATTACHMENT_LIMITS.maxAttachmentBytes
            )}`
          );
        }
        if (skippedForCount > 0) {
          messages.push(
            `maximum ${CHAT_ATTACHMENT_LIMITS.maxAttachments} attachments`
          );
        }
        setAttachmentError(messages.join("; "));
      }
    },
    [store]
  );

  const removeAttachment = useCallback((id: string) => {
    const current = store.getSnapshot();
    const next = current.filter((attachment) => attachment.id !== id);
    store.update(next);
    if (next.length === 0) setAttachmentError(null);
  }, [store]);

  const clearAttachments = useCallback(() => {
    store.update([]);
    setAttachmentError(null);
  }, [store]);

  const stageAttachmentsForSubmit = useCallback(() => {
    const staged = store.getSnapshot();
    if (staged.length === 0) return staged;
    store.update([]);
    setAttachmentError(null);
    return staged;
  }, [store]);

  const settleStagedAttachments = useCallback(
    (staged: ComposerAttachmentDraft[], outcome: "dispose" | "restore") => {
      if (staged.length === 0) return;
      if (outcome === "restore") {
        store.update((current) => {
          const currentIds = new Set(
            current.map((attachment) => attachment.id)
          );
          const next = [
            ...staged.filter((attachment) => !currentIds.has(attachment.id)),
            ...current,
          ];
          return next;
        });
        return;
      }
    },
    [store]
  );

  const prepareAttachmentsForSubmit = useCallback(async () => {
    const staged = stageAttachmentsForSubmit();
    try {
      const payloads = await Promise.all(staged.map(readComposerAttachmentPayload));
      return { attachments: payloads, settle: (accepted: boolean) => settleStagedAttachments(staged, accepted ? "dispose" : "restore") };
    } catch (error) {
      settleStagedAttachments(staged, "restore");
      throw error;
    }
  }, [stageAttachmentsForSubmit, settleStagedAttachments]);

  const restoreAttachmentPayloads = useCallback((payloads: ChatAttachment[]) => {
    addFiles(payloads.map(attachment => {
      const bytes = attachment.contentsBase64
        ? Uint8Array.from(atob(attachment.contentsBase64), character => character.charCodeAt(0))
        : new TextEncoder().encode(attachment.text ?? "");
      const file = new File([bytes], attachment.name, { type: attachment.mediaType });
      if (attachment.relativePath) Object.defineProperty(file, "webkitRelativePath", { value: attachment.relativePath });
      return file;
    }));
  }, [addFiles]);

  return {
    attachmentError,
    attachments,
    addFiles,
    clearAttachments,
    removeAttachment,
    settleStagedAttachments,
    setAttachmentError,
    stageAttachmentsForSubmit,
    prepareAttachmentsForSubmit,
    restoreAttachmentPayloads,
  };
}
