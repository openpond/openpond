import {
  MAKE_AGENT_TUTORIAL_CAPTIONS_URL,
  MAKE_AGENT_TUTORIAL_POSTER_URL,
} from "../../lib/public-assets";
import { MAKE_AGENT_TUTORIAL_VIDEO_URL } from "../../lib/public-video-assets";
import framesManifest from "./how-to-make-an-agent.frames.json";
import type { LearningVideo } from "./LearningVideoCard";

export type MakeAgentTutorialPanelView = "steps" | "script";

export type MakeAgentTutorialState = {
  panelView: MakeAgentTutorialPanelView;
};

export const MAKE_AGENT_TUTORIAL: LearningVideo = {
  captionsUrl: MAKE_AGENT_TUTORIAL_CAPTIONS_URL,
  description: "Create, use, and improve an Account Health Agent.",
  duration: "3:28",
  eyebrow: "Walkthrough",
  id: "make-agent-tutorial",
  posterUrl: MAKE_AGENT_TUTORIAL_POSTER_URL,
  title: "How to make an agent",
  videoUrl: MAKE_AGENT_TUTORIAL_VIDEO_URL,
};

export const MAKE_AGENT_TUTORIAL_CHAPTERS = framesManifest.chapters.map((chapter) => ({
  id: chapter.id,
  label: chapter.label,
  steps: framesManifest.frames
    .filter((frame) => frame.chapter === chapter.id)
    .map((frame) => ({
      id: frame.id,
      label: frame.label,
      narration: frame.narration,
    })),
}));

export const MAKE_AGENT_TUTORIAL_SCRIPT = [
  `# ${framesManifest.tutorial.title}`,
  "",
  framesManifest.tutorial.subtitle,
  "",
  ...MAKE_AGENT_TUTORIAL_CHAPTERS.flatMap((chapter) => [
    `## ${chapter.label}`,
    "",
    ...chapter.steps.flatMap((step) => [
      `### ${step.label}`,
      "",
      step.narration,
      "",
    ]),
  ]),
].join("\n");
