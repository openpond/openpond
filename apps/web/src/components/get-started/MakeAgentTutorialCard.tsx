import type { RefObject } from "react";
import {
  LearningVideoCard,
  LearningVideoPlayer,
} from "./LearningVideoCard";
import { MAKE_AGENT_TUTORIAL } from "./make-agent-tutorial";

export function MakeAgentTutorialCard({
  onClose,
  onOpen,
  open = false,
}: {
  onClose?: () => void;
  onOpen?: () => void;
  open?: boolean;
} = {}) {
  if (!onOpen || !onClose) return <LearningVideoCard video={MAKE_AGENT_TUTORIAL} />;
  return (
    <>
      <LearningVideoCard onPlay={onOpen} video={MAKE_AGENT_TUTORIAL} />
      {open ? (
        <MakeAgentTutorialPlayer
          contained
          inertExclusionSelector=".get-started-learning-panel"
          onClose={onClose}
        />
      ) : null}
    </>
  );
}

export function MakeAgentTutorialPlayer({
  contained = false,
  inertExclusionSelector,
  onClose,
  videoRef,
}: {
  contained?: boolean;
  inertExclusionSelector?: string;
  onClose: () => void;
  videoRef?: RefObject<HTMLVideoElement | null>;
}) {
  return (
    <LearningVideoPlayer
      contained={contained}
      inertExclusionSelector={inertExclusionSelector}
      onClose={onClose}
      video={MAKE_AGENT_TUTORIAL}
      videoRef={videoRef}
    />
  );
}
