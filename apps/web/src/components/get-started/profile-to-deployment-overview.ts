import {
  PROFILE_TO_DEPLOYMENT_CAPTIONS_URL,
  PROFILE_TO_DEPLOYMENT_POSTER_URL,
} from "../../lib/public-assets";
import { PROFILE_TO_DEPLOYMENT_VIDEO_URL } from "../../lib/public-video-assets";
import type { LearningVideo } from "./LearningVideoCard";

export const PROFILE_TO_DEPLOYMENT_OVERVIEW: LearningVideo = {
  captionsUrl: PROFILE_TO_DEPLOYMENT_CAPTIONS_URL,
  description: "Create a Profile, build a Dataset, and launch a reproducible run on OpenPond infrastructure.",
  duration: "1:46",
  eyebrow: "Training walkthrough",
  id: "profile-to-deployment-overview",
  posterUrl: PROFILE_TO_DEPLOYMENT_POSTER_URL,
  title: "Train and deploy with OpenPond",
  videoUrl: PROFILE_TO_DEPLOYMENT_VIDEO_URL,
};
