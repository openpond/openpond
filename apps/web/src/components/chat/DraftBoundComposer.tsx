import { memo } from "react";
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
  const prompt = useComposerDraft(draftStore);
  return (
    <RenderCommitBoundary id="composer">
      <Composer {...props} prompt={prompt} onPromptChange={draftStore.set} />
    </RenderCommitBoundary>
  );
});
