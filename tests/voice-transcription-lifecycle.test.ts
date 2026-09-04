import { describe, expect, test, vi } from "vitest";
import { createComposerDraftStore } from "../apps/web/src/lib/composer-draft-store";
import { deliverVoiceTranscript } from "../apps/web/src/lib/voice-transcript-delivery";
import {
  cancelVoiceTranscription,
  requestVoiceInputSubmit,
  startVoiceTranscription,
  subscribeVoiceTranscription,
  voiceTranscriptionActive,
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
