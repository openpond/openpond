import { lazy, Suspense } from "react";
import type { LabsTab } from "../../lib/app-models";
import type { InsightsViewProps } from "../insights/InsightsView";
import type { ProfileViewProps } from "../profile/ProfileView";
import type { TrainingViewProps } from "../training/TrainingView";
import { profileHasUncommittedLocalChanges } from "../../lib/profile-status";
import { LabsView } from "./LabsView";

const LabsProfile = lazy(() => import("./LabsProfile").then((module) => ({ default: module.LabsProfile })));
const LabsExtensions = lazy(() => import("./LabsExtensions").then((module) => ({ default: module.LabsExtensions })));
const LabsSignals = lazy(() => import("./LabsSignals").then((module) => ({ default: module.LabsSignals })));
const ProfileView = lazy(() => import("../profile/ProfileView").then((module) => ({ default: module.ProfileView })));
const TrainingView = lazy(() => import("../training/TrainingView").then((module) => ({ default: module.TrainingView })));

export type LabsRouteProps = {
  activeTab: LabsTab;
  onNewModel: () => void;
  onTabChange: (tab: LabsTab) => void;
  profileView: ProfileViewProps;
  insights: InsightsViewProps;
  training: Omit<TrainingViewProps, "section" | "onSectionChange">;
};

export function LabsRoute({ activeTab, insights, onNewModel, onTabChange, profileView, training }: LabsRouteProps) {
  return (
    <LabsView
      activeTab={activeTab}
      onNewModel={onNewModel}
      onTabChange={onTabChange}
      profileHasUncommittedChanges={profileHasUncommittedLocalChanges(profileView.payload?.profile)}
    >
      <Suspense fallback={<LabsPanelFallback />}>
        {activeTab === "profile" ? (
          <LabsProfile
            insightsError={insights.error}
            insightsEnabled={insights.enabled}
            insightsItems={insights.items}
            insightsScanning={insights.scanning || insights.scanRunning}
            onTabChange={onTabChange}
            profileView={profileView}
            training={training.training}
          />
        ) : activeTab === "agents" ? (
          <div className="labs-focused-profile-panel">
            <ProfileView {...profileView} section="agents" />
          </div>
        ) : activeTab === "extensions" ? (
          <LabsExtensions />
        ) : activeTab === "models" || activeTab === "evals" ? (
          <TrainingView
            {...training}
            section={activeTab}
            onSectionChange={onTabChange}
          />
        ) : (
          <LabsSignals
            insights={insights}
            training={training}
            onOpenLabsSection={onTabChange}
          />
        )}
      </Suspense>
    </LabsView>
  );
}

function LabsPanelFallback() {
  return <div className="labs-panel-loading" role="status">Loading Lab…</div>;
}
