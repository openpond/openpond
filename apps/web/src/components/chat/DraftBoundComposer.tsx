import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { ComposerDraftStore } from "../../lib/composer-draft-store";
import { useComposerDraft } from "../../lib/composer-draft-store";
import { RenderCommitBoundary } from "../../lib/render-commit-metrics";
import { Composer, type ComposerProps } from "./Composer";

export type DraftBoundComposerProps = Omit<ComposerProps, "onPromptChange" | "prompt"> & {
  draftStore: ComposerDraftStore;
};

export const DraftBoundComposer = memo(function DraftBoundComposer({
  draftStore,
  ...props
}: DraftBoundComposerProps) {
  // Runtime events can recreate parent handlers without changing composer data.
  // Forward events to the latest committed handler without invalidating the draft boundary.
  const onProviderChange = useCommittedEvent(props.onProviderChange);
  const onProviderSetupOpen = useCommittedEvent(props.onProviderSetupOpen);
  const onProfileTargetChange = useCommittedEvent(props.onProfileTargetChange);
  const onWorkspaceTargetChange = useCommittedEvent(props.onWorkspaceTargetChange);
  const onSubmit = useCommittedEvent(props.onSubmit);
  const onStop = useCommittedEvent(props.onStop);
  const status = props.contextWindowStatus;
  const contextWindowStatus = useMemo(() => ({ ...status }), [
    status.usedTokens, status.maxTokens, status.percent, status.summary,
    status.tokensLabel, status.detail, status.tooltip, status.tone,
  ]);
  return <DraftComposerContent {...props} draftStore={draftStore}
    mentionApps={props.mentionApps?.length === 0 ? EMPTY_MENTION_APPS : props.mentionApps}
    contextWindowStatus={contextWindowStatus} onProviderChange={onProviderChange}
    onProviderSetupOpen={onProviderSetupOpen} onProfileTargetChange={onProfileTargetChange}
    onWorkspaceTargetChange={onWorkspaceTargetChange} onSubmit={onSubmit} onStop={onStop} />;
});

const EMPTY_MENTION_APPS: NonNullable<ComposerProps["mentionApps"]> = [];

function useCommittedEvent<T extends ((...args: never[]) => unknown) | undefined>(handler: T): T {
  const latest = useRef(handler);
  useLayoutEffect(() => { latest.current = handler; }, [handler]);
  const forward = useCallback((...args: never[]) => latest.current?.(...args), []);
  return handler ? forward as T : handler;
}

const DraftComposerContent = memo(function DraftComposerContent({
  draftStore,
  ...props
}: DraftBoundComposerProps) {
  const prompt = useComposerDraft(draftStore);
  const draftScopeKey = draftStore.getScopeKey();
  const setScopedPrompt = useCallback(
    (value: Parameters<ComposerDraftStore["set"]>[0]) => {
      draftStore.setForScope(draftScopeKey, value);
    },
    [draftScopeKey, draftStore],
  );
  return (
    <RenderCommitBoundary id="composer">
      <Composer {...props} prompt={prompt} onPromptChange={setScopedPrompt} />
    </RenderCommitBoundary>
  );
});
