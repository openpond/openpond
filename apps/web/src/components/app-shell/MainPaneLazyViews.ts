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
export const ProfileView = lazy(() =>
  import("../profile/ProfileView").then((module) => ({ default: module.ProfileView })),
);
export const BrowserSidebar = lazy(() =>
  import("../browser/BrowserSidebar").then((module) => ({ default: module.BrowserSidebar })),
);
export const CloudWorkView = lazy(() =>
  import("../cloud/CloudWorkView").then((module) => ({ default: module.CloudWorkView })),
);
export const InsightsView = lazy(() =>
  import("../insights/InsightsView").then((module) => ({ default: module.InsightsView })),
);
export const TeamChatView = lazy(() =>
  import("../team-chat/TeamChatView").then((module) => ({ default: module.TeamChatView })),
);
export const TeamAiThreadPanel = lazy(() =>
  import("../team-chat/TeamChatView").then((module) => ({ default: module.TeamAiThreadPanel })),
);
