import { describe, expect, test, vi } from "vitest";
import { createComposerDraftStore } from "../apps/web/src/lib/composer-draft-store";
import { deliverVoiceTranscript } from "../apps/web/src/lib/voice-transcript-delivery";
import {
  cancelVoiceTranscription,
  startVoiceTranscription,
  subscribeVoiceTranscription,
  voiceTranscriptionActive,
} from "../apps/web/src/lib/voice-transcription-job";

describe("voice transcription lifecycle", () => {
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
