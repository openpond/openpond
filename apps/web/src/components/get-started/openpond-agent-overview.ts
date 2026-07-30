import {
  OPENPOND_AGENT_OVERVIEW_CAPTIONS_URL,
  OPENPOND_AGENT_OVERVIEW_POSTER_URL,
} from "../../lib/public-assets";
import { OPENPOND_AGENT_OVERVIEW_VIDEO_URL } from "../../lib/public-video-assets";
import type { LearningVideo } from "./LearningVideoCard";

export const OPENPOND_AGENT_OVERVIEW: LearningVideo = {
  captionsUrl: OPENPOND_AGENT_OVERVIEW_CAPTIONS_URL,
  description: "See how Profile Agents combine chat, direct actions, shared runtime surfaces, and Evals.",
  duration: "1:16",
  eyebrow: "Agent overview",
  id: "openpond-agent-overview",
  posterUrl: OPENPOND_AGENT_OVERVIEW_POSTER_URL,
  title: "What is an OpenPond Agent?",
  videoUrl: OPENPOND_AGENT_OVERVIEW_VIDEO_URL,
};
