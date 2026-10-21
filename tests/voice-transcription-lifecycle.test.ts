import { describe, expect, test, vi } from "vitest";
import { createComposerDraftStore } from "../apps/web/src/lib/composer-draft-store";
import { deliverVoiceTranscript } from "../apps/web/src/lib/voice-transcript-delivery";
import { createComposerTaskSubmission } from "../apps/web/src/components/chat/composer-task-submission";
import type { TaskInboxController } from "../apps/web/src/hooks/useTaskInbox";
import {
  cancelVoiceTranscription,
  requestVoiceInputSubmit,
  startVoiceTranscription,
  subscribeVoiceTranscription,
  voiceTranscriptionActive,
  voiceTranscriptionSubmitRequested,
} from "../apps/web/src/lib/voice-transcription-job";

describe("voice transcription lifecycle", () => {
  test("restores an unsent new-task draft after visiting another chat", () => {
    const draftStore = createComposerDraftStore();
    draftStore.set("A task I still need to finish");
    draftStore.applyAppAction({
      type: "selectSession",
      sessionId: "another-chat",
    });

    expect(draftStore.getSnapshot()).toBe("");

    draftStore.applyAppAction({ type: "beginNewChat", appId: null });

    expect(draftStore.getSnapshot()).toBe("A task I still need to finish");
  });

  test("keeps an in-flight job visible across composer remounts and lets the new composer cancel it", async () => {
    const channelKey = "main-composer-test";
    const firstSubscriber = vi.fn();
    const unsubscribe = subscribeVoiceTranscription(channelKey, firstSubscriber);
    const job = startVoiceTranscription(
      channelKey,
      (signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    );

    expect(voiceTranscriptionActive(channelKey)).toBe(true);
    expect(firstSubscriber).toHaveBeenCalledTimes(1);
    unsubscribe();

    const remountedSubscriber = vi.fn();
    const unsubscribeRemounted = subscribeVoiceTranscription(
      channelKey,
      remountedSubscriber,
    );
    expect(voiceTranscriptionActive(channelKey)).toBe(true);

    cancelVoiceTranscription(channelKey);
    await job;

    expect(voiceTranscriptionActive(channelKey)).toBe(false);
    expect(remountedSubscriber).toHaveBeenCalledTimes(1);
    unsubscribeRemounted();
  });

  test("lets Send mark an in-flight transcription for submission", async () => {
    const channelKey = "voice-submit-test";
    let releaseTranscription!: () => void;
    const transcriptionBarrier = new Promise<void>((resolve) => {
      releaseTranscription = resolve;
    });
    let submitted = false;
    const job = startVoiceTranscription(
      channelKey,
      async (_signal, submitRequested) => {
        await transcriptionBarrier;
        submitted = submitRequested();
      },
    );

    expect(requestVoiceInputSubmit(channelKey)).toBe(true);
    releaseTranscription();
    await job;

    expect(submitted).toBe(true);
  });

  // Failure story: Queue is clicked before transcription returns, then navigation
  // sends a partial message to the wrong chat or drops the origin draft on failure.
  test.each([false, true])("finishes transcription before queuing in its original chat (accepted: %s)", async (accepted) => {
    const channelKey = `voice-queue-navigation-${accepted}`;
    const draftStore = createComposerDraftStore({ selectedAppId: null, selectedProjectId: null, selectedSessionId: "origin" });
    draftStore.set("Typed first");
    const originKey = draftStore.getScopeKey();
    const setOriginDraft = (value: string) => draftStore.setForScope(originKey, value);
    let currentScope = "origin";
    let finishTranscription!: () => void;
    let acknowledgeQueue!: () => void;
    const transcription = new Promise<void>(resolve => { finishTranscription = resolve; });
    const receipt = new Promise<void>(resolve => { acknowledgeQueue = resolve; });
    const queue = vi.fn(async () => { await receipt; return accepted; });
    const steer = vi.fn();
    const onSubmit = vi.fn(async () => true);
    const submission = createComposerTaskSubmission({
      running: true, scope: "origin", provider: "codex", model: "test-model",
      codexPermissionMode: "default", codexReasoningEffort: "medium", openPondCommandAccessMode: "full-access",
      inbox: { enabled: true, queue, steer } as unknown as TaskInboxController,
      getPrompt: () => draftStore.getSnapshot(), getCurrentSubmissionScopeKey: () => currentScope,
      hasActions: false, begin: () => true, finish: vi.fn(),
      clear: () => setOriginDraft(""), setError: vi.fn(), stageLocal: vi.fn(), onSubmit, showToast: vi.fn(),
    });
    let signal!: AbortSignal;
    const job = startVoiceTranscription(channelKey, async (jobSignal, submitRequested) => {
      signal = jobSignal;
      await transcription;
      await deliverVoiceTranscript({
        appendToEnd: submitRequested(), submit: submitRequested(),
        currentScopeKey: currentScope, originScopeKey: "origin", cursorIndex: 0,
        prompt: "Typed first", transcript: "and dictated second", setOriginDraft,
        submitFromOrigin: submission.stageCurrentSteerDraft,
      });
    });
    expect(requestVoiceInputSubmit(channelKey)).toBe(true);
    expect(requestVoiceInputSubmit(channelKey)).toBe(true);
    expect(voiceTranscriptionSubmitRequested(channelKey)).toBe(true);
    draftStore.applyAppAction({ type: "selectSession", sessionId: "destination" });
    draftStore.set("Other chat draft");
    currentScope = "destination";
    expect(queue).not.toHaveBeenCalled();
    finishTranscription();
    await vi.waitFor(() => expect(queue).toHaveBeenCalledOnce());
    expect(signal.aborted).toBe(false);
    expect(voiceTranscriptionActive(channelKey)).toBe(true);
    expect(requestVoiceInputSubmit(channelKey)).toBe(true);
    acknowledgeQueue();
    await job;
    expect(voiceTranscriptionActive(channelKey)).toBe(false);
    expect(voiceTranscriptionSubmitRequested(channelKey)).toBe(false);
    expect(queue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: "Typed first and dictated second" }));
    expect(steer).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(draftStore.getSnapshot()).toBe("Other chat draft");
    draftStore.applyAppAction({ type: "selectSession", sessionId: "origin" });
    expect(draftStore.getSnapshot()).toBe(accepted ? "" : "Typed first and dictated second");
  });

  test("appends a submitted transcript after all typed text", async () => {
    const setOriginDraft = vi.fn();

    const delivery = await deliverVoiceTranscript({
      appendToEnd: true,
      currentScopeKey: "new-task",
      cursorIndex: 0,
      originScopeKey: "new-task",
      prompt: "Typed before recording",
      setOriginDraft,
      submitFromOrigin: vi.fn(async () => true),
      transcript: "dictated after it",
    });

    expect(delivery).toBe("drafted");
    expect(setOriginDraft).toHaveBeenCalledWith(
      "Typed before recording dictated after it",
    );
  });

  test("submits from the originating chat after navigation and clears its draft", async () => {
    const draftStore = createComposerDraftStore({
      selectedAppId: null,
      selectedProjectId: null,
      selectedSessionId: "origin",
    });
    draftStore.set("Typed first");
    const originDraftScopeKey = draftStore.getScopeKey();
    const setOriginDraft = (value: string) =>
      draftStore.setForScope(originDraftScopeKey, value);
    draftStore.applyAppAction({
      type: "selectSession",
      sessionId: "destination",
    });

    const submitFromOrigin = vi.fn(async () => true);
    const delivery = await deliverVoiceTranscript({
      currentScopeKey: "destination",
      cursorIndex: "Typed first".length,
      originScopeKey: "origin",
      prompt: "Typed first",
      setOriginDraft,
      submitFromOrigin,
      transcript: "and dictated second",
    });

    expect(delivery).toBe("submitted");
    expect(submitFromOrigin).toHaveBeenCalledWith(
      "Typed first and dictated second",
    );
    expect(draftStore.getSnapshot()).toBe("");
    draftStore.applyAppAction({ type: "selectSession", sessionId: "origin" });
    expect(draftStore.getSnapshot()).toBe("");
  });

  test("retains the transcript in the originating draft when background sending fails", async () => {
    const draftStore = createComposerDraftStore({
      selectedAppId: null,
      selectedProjectId: null,
      selectedSessionId: "origin",
    });
    draftStore.set("Typed first");
    const originDraftScopeKey = draftStore.getScopeKey();
    const setOriginDraft = (value: string) =>
      draftStore.setForScope(originDraftScopeKey, value);
    draftStore.applyAppAction({
      type: "selectSession",
      sessionId: "destination",
    });

    const submitFromOrigin = vi.fn(async () => false);
    const delivery = await deliverVoiceTranscript({
      currentScopeKey: "destination",
      cursorIndex: "Typed first".length,
      originScopeKey: "origin",
      prompt: "Typed first",
      setOriginDraft,
      submitFromOrigin,
      transcript: "and dictated second",
    });

    expect(delivery).toBe("retained");
    expect(submitFromOrigin).toHaveBeenCalledWith(
      "Typed first and dictated second",
    );
    expect(draftStore.getSnapshot()).toBe("");
    draftStore.applyAppAction({ type: "selectSession", sessionId: "origin" });
    expect(draftStore.getSnapshot()).toBe("Typed first and dictated second");
  });
});
