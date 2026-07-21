import { lazy } from "react";

export const WorkspaceDiffPanel = lazy(() =>
  import("../workspace-diff/WorkspaceDiffPanel").then((module) => ({ default: module.WorkspaceDiffPanel })),
);
export const AppsView = lazy(() =>
  import("../apps/AppsView").then((module) => ({ default: module.AppsView })),
);
export const GetStartedView = lazy(() =>
  import("../get-started/GetStartedView").then((module) => ({ default: module.GetStartedView })),
);
export const PostTrainingLearningPanel = lazy(() =>
  import("../get-started/PostTrainingLearningPanel").then((module) => ({
    default: module.PostTrainingLearningPanel,
  })),
);
export const MakeAgentTutorialLearningPanel = lazy(() =>
  import("../get-started/MakeAgentTutorialLearningPanel").then((module) => ({
    default: module.MakeAgentTutorialLearningPanel,
  })),
);
export const LabsRoute = lazy(() =>
  import("../labs/LabsRoute").then((module) => ({ default: module.LabsRoute })),
);
export const BrowserSidebar = lazy(() =>
  import("../browser/BrowserSidebar").then((module) => ({ default: module.BrowserSidebar })),
);
export const RightChatPanelStack = lazy(() =>
  import("./RightChatPanelStack").then((module) => ({ default: module.RightChatPanelStack })),
);
export const NativeSkillSidebar = lazy(() =>
  import("./NativeSkillSidebar").then((module) => ({ default: module.NativeSkillSidebar })),
);
export const CloudWorkView = lazy(() =>
  import("../cloud/CloudWorkView").then((module) => ({ default: module.CloudWorkView })),
);
export const TeamChatView = lazy(() =>
  import("../team-chat/TeamChatView").then((module) => ({ default: module.TeamChatView })),
);
export const CommunityView = lazy(() =>
  import("../community/CommunityView").then((module) => ({ default: module.CommunityView })),
);
export const TeamAiThreadPanel = lazy(() =>
  import("../team-chat/TeamChatView").then((module) => ({ default: module.TeamAiThreadPanel })),
);
export const TeamAgentConversationPanel = lazy(() =>
  import("../team-chat/TeamChatView").then((module) => ({
    default: module.TeamAgentConversationPanel,
  })),
);
