import { useQuery } from "@tanstack/react-query";
import { parseAndVerifySavedModelVersionRead } from "openpond-sdk/training";
import type { ModelProject } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { ErrorToast } from "../common/ErrorToast";
import { modelsLocation, navigateModelsRoute } from "./lab-primary-tab-state";
import "./hosted-training-run.css";
import { SavedModelServing } from "./SavedModelServing";
import type { WorkspaceApi } from "./workspace/workspace-api";

export function useSavedTrainingModel(
  connection: ClientConnection | null | undefined,
  hosted: ModelProject["hosted"] | undefined,
) {
  return useQuery({
    queryKey: [
      "saved-training-model",
      connection ? connectionQueryScope(connection) : null,
      hosted?.apiOrigin,
      hosted?.teamId,
      hosted?.projectId,
    ],
    enabled: Boolean(connection && hosted),
    queryFn: async ({ signal }) => {
      if (!connection || !hosted)
        throw new Error("Load the hosted Model before reading its saved version.");
      return parseAndVerifySavedModelVersionRead(
        await apiFetch(
          connection,
          `/v1/training/saved-models/${encodeURIComponent(hosted.projectId)}/version?teamId=${encodeURIComponent(hosted.teamId)}`,
          { signal },
        ),
        hosted.teamId,
        hosted.projectId,
      );
    },
    staleTime: 30_000,
    gcTime: 300_000,
    retry: false,
  });
}

export function SavedTrainingModel({
  query,
  connection,
  api,
}: {
  query: ReturnType<typeof useSavedTrainingModel>;
  connection: ClientConnection;
  api?: WorkspaceApi;
}) {
  const version = query.data?.version;
  return (
    <section className="training-detail-section" aria-label="Saved modifications">
      <div className="labs-project-trends-heading">
        <h2>Saved modifications</h2>
        <button
          className="training-button secondary"
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh saved version
        </button>
      </div>
      <ErrorToast error={query.error} />
      {query.isPending ? (
        <p role="status">Loading saved version…</p>
      ) : query.isSuccess && !version ? (
        <p>No result has been saved to this Model.</p>
      ) : null}
      {version ? (
        <>
          {version.schemaVersion === "openpond.steeringModelVersion.v1" ? (
            <dl className="model-project-page-metrics">
              <div>
                <dt>Method</dt>
                <dd>Neuron steering</dd>
              </div>
              <div>
                <dt>Base model</dt>
                <dd>{version.publication.baseModel.modelId}</dd>
                <small>{version.publication.baseModel.revision}</small>
              </div>
              <div>
                <dt>Exact profile</dt>
                <dd>
                  {version.publication.id} · revision {version.publication.revision}
                </dd>
              </div>
            </dl>
          ) : version.schemaVersion === "openpond.alphaEditModelVersion.v1" ||
            version.schemaVersion === "openpond.neuronTrainingModelVersion.v1" ? (
            <>
              <dl className="model-project-page-metrics">
                <div>
                  <dt>Method</dt>
                  <dd>
                    {version.schemaVersion === "openpond.alphaEditModelVersion.v1"
                      ? "AlphaEdit"
                      : "Neuron training"}
                  </dd>
                </div>
                <div>
                  <dt>Base model</dt>
                  <dd>{version.baseModel.modelId}</dd>
                  <small>{version.baseModel.revision}</small>
                </div>
                <div>
                  <dt>Exact learned weights</dt>
                  <dd>{version.artifact.id}</dd>
                  <small>{version.artifact.contentHash}</small>
                </div>
              </dl>
              <button
                type="button"
                className="training-button secondary"
                onClick={() =>
                  void navigateModelsRoute(
                    modelsLocation("experiments", null, {
                      resourceId: `${version.schemaVersion === "openpond.alphaEditModelVersion.v1" ? "managed-alphaedit" : "managed-neuron-training"}:${version.source.executionId}`,
                    }),
                  )
                }
              >
                Open producing experiment
              </button>
              {version.schemaVersion === "openpond.neuronTrainingModelVersion.v1" ? (
                <p>
                  Training continuation is unavailable for the saved inference delta. Choose a
                  managed base explicitly for a fresh experiment.
                </p>
              ) : null}
            </>
          ) : version.schemaVersion === "openpond.decisionModelVersion.v1" ? (
            <>
              <dl className="model-project-page-metrics">
                <div>
                  <dt>Method</dt>
                  <dd>Decision model</dd>
                </div>
                <div>
                  <dt>Base model</dt>
                  <dd>{version.baseModel.modelId}</dd>
                  <small>{version.baseModel.revision}</small>
                </div>
                <div>
                  <dt>Exact adapter</dt>
                  <dd>{version.artifact.id}</dd>
                  <small>{version.artifact.contentHash}</small>
                </div>
              </dl>
              <button
                type="button"
                className="training-button secondary"
                onClick={() =>
                  void navigateModelsRoute(
                    modelsLocation("experiments", null, {
                      resourceId: `managed-decision:${version.source.executionId}`,
                    }),
                  )
                }
              >
                Open producing experiment
              </button>
            </>
          ) : version.schemaVersion === "openpond.engramModelVersion.v1" ? (
            <>
              <dl className="model-project-page-metrics">
                <div>
                  <dt>Method</dt>
                  <dd>Engram memory</dd>
                </div>
                <div>
                  <dt>Base model</dt>
                  <dd>{version.baseModel.modelId}</dd>
                  <small>{version.baseModel.revision}</small>
                </div>
                <div>
                  <dt>Exact module</dt>
                  <dd>{version.artifact.id}</dd>
                  <small>{version.artifact.contentHash}</small>
                </div>
              </dl>
              <button
                type="button"
                className="training-button secondary"
                onClick={() =>
                  void navigateModelsRoute(
                    modelsLocation("experiments", null, {
                      resourceId: `managed-engram:${version.source.executionId}`,
                    }),
                  )
                }
              >
                Open producing experiment
              </button>
            </>
          ) : (
            <>
              <dl className="model-project-page-metrics">
                <div>
                  <dt>Method</dt>
                  <dd>{String(version.request.recipe.method).toUpperCase()}</dd>
                </div>
                <div>
                  <dt>Base model</dt>
                  <dd>{version.request.baseModel.modelId}</dd>
                  <small>{version.request.baseModel.revision}</small>
                </div>
                <div>
                  <dt>Composition</dt>
                  <dd>
                    {
                      {
                        base: "Standalone adapter",
                        residual_append: "Stacked adapter",
                        shared: "Shared adapter",
                        sequential_merge: "Sequential merge",
                      }[version.candidate.composition]
                    }
                  </dd>
                </div>
              </dl>
              <button
                type="button"
                className="training-button secondary"
                onClick={() =>
                  void navigateModelsRoute(
                    modelsLocation("runs", null, { resourceId: `hosted-run:${version.jobId}` }),
                  )
                }
              >
                Open producing experiment
              </button>
            </>
          )}
          <details>
            <summary>Saved version and original settings</summary>
            <pre className="saved-model-version-reference">{JSON.stringify(version, null, 2)}</pre>
          </details>
          <SavedModelServing
            key={`${api?.key ?? "read"}:${version.modelProjectId}:${version.contentHash}`}
            connection={connection}
            version={version}
            api={api}
          />
        </>
      ) : null}
    </section>
  );
}
