import { useQuery } from "@tanstack/react-query";
import { useWorkspaceResourceName } from "./WorkspacePanel";
import { EvaluationCard } from "./EvaluationPresentation";
import { useLocalLearningCatalog, profileDisplayName, LocalDatasetMetadataSchema, localMetadataGraders } from "./local-learning-catalog";
import type { WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";
export function LocalGraderPage({ api, route, navigate }: { api: WorkspaceApi; route: ModelsRoute; navigate: (value: ModelsRoute) => void }) {
  const query = useLocalLearningCatalog(api);
  const found = query.data?.flatMap(dataset => dataset.graders.map(grader => ({ dataset, grader }))).find(row => row.grader.id === route.resourceId);
  const historical = useQuery({ queryKey: ["local-grader-revision", api.key, found?.dataset.summary.id, route.revision],
    enabled: Boolean(found && route.revision && route.revision !== found.dataset.summary.revision),
    queryFn: async ({signal}) => LocalDatasetMetadataSchema.parse(await api.localDatasets("read", {view:"metadata",revision:route.revision}, found!.dataset.summary.id, signal)),
  });
  useWorkspaceResourceName(found?.grader.name ?? null);
  if (query.isPending) return <p role="status">Loading grader…</p>;
  if (query.error) return <p role="alert">{query.error.message} <button className="training-text-button" onClick={() => void query.refetch()}>Retry</button></p>;
  if (!found) return <p role="alert">This saved local grader is unavailable.</p>;
  if (route.revision && route.revision !== found.dataset.summary.revision && historical.isPending) return <p role="status">Loading saved grader revision…</p>;
  if (historical.error) return <p role="alert">{historical.error.message}</p>;
  const dataset = historical.data ? {...found.dataset,summary:historical.data.summary} : found.dataset;
  const grader = historical.data ? localMetadataGraders(historical.data.record).find(grader=>grader.graderId===found.grader.graderId) : found.grader;
  if (!grader) return <p role="alert">This grader was not part of the selected Dataset revision.</p>;
  if (route.contentHash && route.contentHash !== grader.configurationHash || route.revision && route.revision !== dataset.summary.revision)
    return <p role="alert">This grader's saved Dataset revision changed. <button className="training-text-button" onClick={() => navigate({ ...route, revision: dataset.summary.revision, contentHash: grader.configurationHash })}>Open current version</button></p>;
  return <>
    <header className="evaluation-workspace-header"><h1>{grader.name}</h1><button className="training-button secondary" onClick={() => navigate({ ...route, page: "datasets",
      resourceId: dataset.summary.id, detailTab: "graders", revision: undefined, contentHash: undefined, executionLocation: "local" })}>Open Dataset</button></header>
    <EvaluationCard title={grader.name}><dl className="evaluation-workspace-meta">
      <dt>Profile</dt><dd>{profileDisplayName(dataset.profileTarget?.profileId)}</dd><dt>Workflow</dt><dd>{dataset.profileTarget?.workflowId ?? "—"}</dd>
      <dt>Dataset</dt><dd>{dataset.summary.name} · Revision {dataset.summary.revision}</dd><dt>Grader</dt><dd>{grader.graderId} · Version {grader.version}</dd>
      <dt>Type</dt><dd>{grader.kind.replaceAll("_", " ")}</dd><dt>Checked examples</dt><dd>{grader.checkState}</dd>
      <dt>Weight</dt><dd>{grader.weight}</dd><dt>Hard gate</dt><dd>{grader.hardGate ? "Yes" : "No"}</dd>
      <dt>Training reward</dt><dd>{grader.rewardEligible ? "Eligible" : "Validation only"}</dd><dt>Expected answers</dt><dd>{grader.privileged ? "Evaluator-private" : "Policy-visible contract"}</dd>
      {grader.fields.length ? <><dt>Checked fields</dt><dd>{grader.fields.join(", ")}</dd></> : null}
      {grader.verifierPath ? <><dt>Verifier</dt><dd>{grader.verifierPath}</dd></> : null}
      <dt>Configuration hash</dt><dd>{grader.configurationHash}</dd>
    </dl></EvaluationCard>
  </>;
}
