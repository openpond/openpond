import type { CreateImproveRun, OpenPondProfileState } from "@openpond/contracts";
import type { LabsRouteProps } from "./labs-route-types";
import type { LabWorkproductSummary } from "./lab-workproducts";
import { LabWorkproductDetail } from "./LabWorkproductDetail";
import { modelsLocation, navigateModelsRoute, type ModelsRoute } from "./lab-primary-tab-state";

export function ModelsResourceDetail({ props, model, profile, runs, route }: {
  props: LabsRouteProps; model: LabWorkproductSummary; profile: OpenPondProfileState | null;
  runs: CreateImproveRun[]; route: ModelsRoute;
}) {
  const { training, profileView } = props;
  const openDataset = (id: string) => { void navigateModelsRoute(modelsLocation("tasksets", route.modelId, { resourceId: id })); };
  const openEntry = (ref: string | null) => {
    const page = ref?.startsWith("version:") ? "versions" : route.page === "versions" ? "versions" : "runs";
    void navigateModelsRoute(modelsLocation(page, route.modelId, { resourceId: ref }));
  };
  return <LabWorkproductDetail
    connection={profileView.connection} profile={profile} runs={runs} training={training.training} workproduct={model}
    modelSection={route.page === "runs" ? "training" : route.page === "versions" ? "versions" : "overview"}
    modelDetailTab={route.detailTab} selectedModelEntryKey={route.resourceId}
    onModelDetailTabChange={(detailTab) => { void navigateModelsRoute({ ...route, detailTab }); }}
    onSelectedModelEntryKeyChange={openEntry}
    onAnswerQuestion={props.onAnswerQuestion} onApplyCandidate={props.onApplyCandidate} onApprove={props.onApprove} onCancel={props.onCancel}
    candidateReview={props.candidateReview} onCandidateReviewChange={props.onCandidateReviewChange}
    onChatWithModel={training.onChatWithModel} onOpenPullRequest={props.onOpenPullRequest} onOpenCandidateFiles={props.onOpenCandidateFiles}
    onOpenConversation={props.onOpenRunConversation}
    onOpenComparison={(id) => { void navigateModelsRoute(modelsLocation("runs", route.modelId, { collection: "series", resourceId: id })); }}
    onClose={() => { void navigateModelsRoute(modelsLocation(route.page, route.modelId)); }}
    onLocationChange={props.onDetailOpenChange} onRenameAgent={() => undefined} onOpenDataset={openDataset}
    onPause={props.onPause} onReconcilePullRequest={props.onReconcilePullRequest} onRejectCandidate={props.onRejectCandidate} onResume={props.onResume} onRevise={props.onRevise}
    onNewModelRun={(initialTasksetId) => { props.onNewModel(initialTasksetId ?? undefined, null, model.id); void navigateModelsRoute(modelsLocation("runs", model.id, { collection: "new", resourceId: model.id })); }}
    onStartAgentChange={() => undefined} onToast={training.onToast}
    benchmarkDefaultModel={training.defaultModel} benchmarkProviderSettings={training.providerSettings}
  />;
}
