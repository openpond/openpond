import { expect, test, vi } from "vitest";
import type { ChatAttachment } from "@openpond/contracts";
import type { TaskInboxController } from "../apps/web/src/hooks/useTaskInbox";
import { createComposerTaskSubmission } from "../apps/web/src/components/chat/composer-task-submission";

const attachments: ChatAttachment[] = [{ id: "file", name: "notes.txt", kind: "text", mediaType: "text/plain", sizeBytes: 8, text: "Evidence", contentsBase64: "RXZpZGVuY2U=" }];

// Failure story: steering/queuing accepts only the text, or disposes the selected
// files even when the server rejects admission, preventing a complete retry.
test.each(["steer", "queued"] as const)("%s sends files with the instruction and restores them on rejection", async kind => {
  for (const accepted of [false, true]) {
    const settle = vi.fn(), clear = vi.fn();
    const steer = vi.fn(async () => accepted), queue = vi.fn(async () => accepted);
    const submit = createComposerTaskSubmission({
      running: true, scope: "original", provider: "codex", model: "model", hasActions: false, attachmentCount: 1,
      codexPermissionMode: "default", codexReasoningEffort: "medium", openPondCommandAccessMode: "full-access",
      inbox: { enabled: true, steer, queue } as unknown as TaskInboxController,
      prepareAttachments: async () => ({ attachments, settle }), getPrompt: () => "Review this evidence",
      begin: () => true, finish: vi.fn(), clear, setError: vi.fn(), stageLocal: vi.fn(),
      onSubmit: vi.fn(async () => false), showToast: vi.fn(),
    });
    expect(await (kind === "steer" ? submit.submitImmediateSteer() : submit.stageCurrentSteerDraft())).toBe(accepted);
    if (kind === "steer") expect(steer).toHaveBeenCalledExactlyOnceWith("Review this evidence", [], attachments);
    else expect(queue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: "Review this evidence", attachments }));
    expect(settle).toHaveBeenCalledExactlyOnceWith(accepted);
    expect(clear).toHaveBeenCalledTimes(accepted ? 1 : 0);
  }
});
