import type { LocalExperimentSourceChoices } from "@openpond/contracts";
import type { DatasetPopulationPage } from "openpond-sdk/dataset-workspaces";
import type { ModelsRoute } from "../models-route";
import { EvaluationCard } from "./EvaluationPresentation";
import { EvaluationTableState } from "./EvaluationTableState";

type ProfileDataset = LocalExperimentSourceChoices["profiles"][number];

export function LocalProfileDatasetGraders({ population, loading, error, retry }: {
  population: DatasetPopulationPage | undefined;
  loading: boolean;
  error?: string;
  retry: () => void;
}) {
  return <>
    <p>These immutable grader pins belong to the released Dataset on this computer.</p>
    <table className="training-data-table evaluation-workspace-table">
      <thead><tr><th>Grader</th><th>Feedback key</th><th>Version</th><th>Release</th></tr></thead>
      <tbody>{population?.graders.map((grader) => <tr key={`${grader.id}:${grader.contentHash}:${grader.feedbackKey}`}>
        <td><strong>{grader.name ?? grader.id}</strong>
          <details><summary>Immutable grader evidence</summary>
            <dl className="evaluation-workspace-meta">
              <dt>Dataset grader</dt><dd>{grader.id}</dd>
              <dt>Content hash</dt><dd>{grader.contentHash}</dd>
              {grader.release ? <><dt>Reward content hash</dt><dd>{grader.release.contentHash}</dd></> : null}
            </dl>
            {grader.mappings ? <><p>Field mappings</p><pre>{JSON.stringify(grader.mappings, null, 2)}</pre></> : null}
          </details>
        </td>
        <td>{grader.feedbackKey}</td><td>{grader.version}</td>
        <td>{grader.release ? `${grader.release.id} · Revision ${grader.release.revision}` : "Dataset-owned"}</td>
      </tr>)}
        <EvaluationTableState columns={4} loading={loading} error={error}
          empty={!population?.graders.length} retry={retry}>
          This released Dataset has no available grader pins.
        </EvaluationTableState>
      </tbody>
    </table>
  </>;
}

export function LocalProfileDatasetVersions({ source, sources, population, route, navigate, loading, error, retry }: {
  source: ProfileDataset | undefined;
  sources: ProfileDataset[];
  population: DatasetPopulationPage | undefined;
  route: ModelsRoute;
  navigate: (route: ModelsRoute) => void;
  loading: boolean;
  error?: string;
  retry: () => void;
}) {
  const versions = source ? [...new Map(sources.filter((item) => item.taskset.id === source.taskset.id)
    .map((item) => [`${item.taskset.revision}:${item.taskset.contentHash}`, item])).values()]
    .sort((a, b) => b.taskset.revision - a.taskset.revision) : [];
  return <>
    <p>Authorized released versions from accepted local Profile sources. Selecting a version retains its exact Dataset and source pins.</p>
    <table className="training-data-table evaluation-workspace-table">
      <thead><tr><th>Version</th><th>Dataset hash</th><th>Profile source revision</th></tr></thead>
      <tbody>{versions.map((item) => <tr key={`${item.taskset.revision}:${item.taskset.contentHash}`}>
        <td><button className="training-text-button" onClick={() => navigate({ ...route,
          resourceId: item.id, detailTab: "tasks", revision: item.taskset.revision,
          contentHash: item.taskset.contentHash, after: null })}>
          Revision {item.taskset.revision}{item.id === source?.id ? " · Selected" : ""}
        </button></td>
        <td>{item.taskset.contentHash}</td><td>{item.sourceRevision}</td>
      </tr>)}
        <EvaluationTableState columns={3} loading={loading} error={error}
          empty={!versions.length} retry={retry}>
          No authorized released versions are available on this computer.
        </EvaluationTableState>
      </tbody>
    </table>
    {source && population ? <EvaluationCard title="Selected immutable source">
      <dl className="evaluation-workspace-meta">
        <dt>Dataset release</dt><dd>{population.release.id} · Revision {population.release.revision}</dd>
        <dt>Dataset hash</dt><dd>{population.release.contentHash}</dd>
        <dt>Policy population receipt</dt><dd>{population.contentHash}</dd>
        <dt>Profile</dt><dd>{source.profileRef.profileId} · {source.profileRef.repositoryId}</dd>
        <dt>Profile source revision</dt><dd>{source.sourceRevision}</dd>
        <dt>Harness release</dt><dd>{source.harnessRelease.id} · {source.harnessRelease.contentHash}</dd>
        <dt>Evaluation definition</dt><dd>{source.definitionId} · {source.definitionHash}</dd>
        <dt>Declared seeds</dt><dd>{source.seeds.join(", ")}</dd>
      </dl>
    </EvaluationCard> : null}
  </>;
}
