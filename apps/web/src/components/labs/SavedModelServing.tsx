import { DecisionModelScoring } from "./DecisionModelScoring";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  parseAndVerifySavedModelServing,
  type TrainingModelServing,
  type SavedModelVersion,
} from "openpond-sdk/training";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { ErrorToast } from "../common/ErrorToast";
import { LabStatusBadge } from "./LabStatusBadge";
import { ModelServingControlDialog } from "./ModelServingControlDialog";
import type { WorkspaceApi } from "./workspace/workspace-api";

const labels: Record<TrainingModelServing["state"], string> = {
  unpublished: "Publication pending",
  qualification_pending: "Qualification pending",
  unavailable: "Unavailable",
  inactive: "No active routing",
  starting: "Starting",
  active: "Active routing",
  retiring: "Retiring capacity",
};
const reasons: Record<NonNullable<TrainingModelServing["registry"]>["reason"], string> = {
  qualified: "Qualified for this serving runtime.",
  evaluation_pending: "Registry evaluation is pending.",
  post_training_pending: "Required post-training checks are pending.",
  evaluation_failed: "Registry evaluation did not pass.",
  candidate_rejected: "This candidate was rejected.",
  artifact_revoked: "This registry artifact was revoked.",
  artifact_deleted: "This registry artifact was deleted.",
  runtime_unavailable: "The published runtime does not match this saved base model.",
};

/** Native registry/pool observations stay distinct from live worker residency. */
export function SavedModelServing({
  connection,
  version,
  api,
}: {
  connection: ClientConnection;
  version: SavedModelVersion;
  api?: WorkspaceApi;
}) {
  const { teamId, modelProjectId, contentHash: versionHash } = version;
  const [review, setReview] = useState<"activate" | "stop" | null>(null);
  const query = useQuery({
    queryKey: [
      "saved-model-serving",
      connectionQueryScope(connection),
      teamId,
      modelProjectId,
      versionHash,
    ],
    queryFn: async ({ signal }) =>
      parseAndVerifySavedModelServing(
        await apiFetch(
          connection,
          `/v1/training/saved-models/${encodeURIComponent(modelProjectId)}/serving?${new URLSearchParams({ teamId, versionHash })}`,
          { signal },
        ),
        { teamId, modelProjectId, versionHash },
      ),
    staleTime: 10_000,
    gcTime: 300_000,
    retry: false,
    refetchInterval: (current) => {
      if (current.state.error) return false;
      const data = current.state.data;
      if (!data) return false;
      if (
        data.cleanup.some((row) => ["pending", "retiring"].includes(row.capacityState)) ||
        ["starting", "retiring"].includes(data.state) ||
        (data.control &&
          (data.control.desiredState === "stopped" || data.control.phase === "failed") &&
          ["pending", "retiring"].includes(data.control.capacityState))
      )
        return 5_000;
      return data.cleanup.length ? 30_000 : false;
    },
    refetchIntervalInBackground: false,
  });
  const value = query.data;
  const allowed =
    value &&
    !query.error &&
    (value.control?.desiredState === "active"
      ? value.control.versionHash === versionHash
      : value.schemaVersion === "openpond.steeringModelServing.v1" ||
          value.schemaVersion === "openpond.engramModelServing.v1" ||
          value.schemaVersion === "openpond.decisionModelServing.v1" ||
          value.schemaVersion === "openpond.alphaEditModelServing.v1" ||
          value.schemaVersion === "openpond.neuronTrainingModelServing.v1"
        ? value.availability.state === "qualified" &&
          value.control?.phase !== "stopping" &&
          !value.cleanup.some((row) => !["shared", "released"].includes(row.capacityState))
        : value.registry?.qualified && Boolean(value.serverlessReview) && value.control?.phase !== "stopping");
  return (
    <section aria-label="Serving state">
      <div className="labs-project-trends-heading">
        <h3>Serving</h3>
        <button
          className="training-button secondary"
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh serving state
        </button>
      </div>
      <ErrorToast error={query.error} />
      {query.isPending ? <p role="status">Reading serving state…</p> : null}
      {api ? (
        <div className="model-build-actions">
          <button
            className="training-button"
            type="button"
            disabled={query.isFetching || !allowed}
            onClick={() =>
              setReview(value?.control?.desiredState === "active" ? "stop" : "activate")
            }
          >
            {value?.control?.desiredState === "active"
              ? "Stop serving"
              : value?.control?.phase === "stopping"
                ? "Stopping…"
                : "Activate"}
          </button>
          <button
            className="training-button secondary"
            type="button"
            onClick={() =>
              setReview(value?.control?.desiredState === "active" ? "stop" : "activate")
            }
          >
            Review serving request
          </button>
        </div>
      ) : null}
      {value ? (
        <>
          <dl className="model-project-page-metrics">
            {value.schemaVersion === "openpond.trainingModelServing.v1" && value.control?.serverless ? (
              <>
                <div><dt>Serving usage</dt><dd>{(value.control.serverless.quantityMicros / 1_000_000).toFixed(3)} allocated seconds</dd></div>
                <div><dt>Serving charged</dt><dd>US${value.control.serverless.chargedUsd}</dd></div>
                <div><dt>Reserved for requests</dt><dd>US${value.control.serverless.reservedUsd}</dd></div>
                <div><dt>Serving spending limit</dt><dd>{value.control.serverless.customerCapUsd ? `US$${value.control.serverless.customerCapUsd}` : "Available workspace credit"}</dd></div>
              </>
            ) : null}
            <div>
              <dt>Routing</dt>
              <dd>
                <LabStatusBadge label={labels[value.state]} value={value.state} />
              </dd>
            </div>
            <div>
              <dt>Active binding records</dt>
              <dd>{value.bindings.length}</dd>
            </div>
            <div>
              <dt>Last verified inference</dt>
              <dd>
                {value.schemaVersion === "openpond.decisionModelServing.v1"
                  ? value.lastVerifiedScore
                    ? new Date(value.lastVerifiedScore.completedAt).toLocaleString()
                    : "No retained score"
                  : value.lastVerifiedInference
                    ? new Date(value.lastVerifiedInference.completedAt).toLocaleString()
                    : "No retained evidence"}
              </dd>
            </div>
            {value.control ? (
              <>
                <div>
                  <dt>Serving request</dt>
                  <dd>{value.control.phase}</dd>
                </div>
                <div>
                  <dt>Capacity</dt>
                  <dd>
                    {value.control.desiredState === "active" && value.control.phase !== "failed"
                      ? "Managed by serving runtime"
                      : {
                          pending: "Cleanup pending",
                          shared: "Retained for current consumers",
                          retiring: "Retirement in progress",
                          released: "Retirement complete",
                        }[value.control.capacityState]}
                  </dd>
                </div>
                <div>
                  <dt>Model ID</dt>
                  <dd>{value.control.modelId}</dd>
                </div>
              </>
            ) : null}
          </dl>
          {value.schemaVersion === "openpond.trainingModelServing.v1" && value.registry ? (
            <p>{reasons[value.registry.reason]}</p>
          ) : value.schemaVersion === "openpond.steeringModelServing.v1" ? (
            <p>
              {
                {
                  qualified: "Qualified for this serving runtime.",
                  runtime_unavailable: "A compatible serving runtime has not been qualified.",
                  calibration_unavailable: "The original calibration is unavailable.",
                  profile_archived: "This saved profile is archived.",
                  model_mismatch: "The serving runtime differs from this exact model.",
                }[value.availability.reason]
              }
            </p>
          ) : null}
          {value.schemaVersion === "openpond.engramModelServing.v1" ? (
            <>
              <p>
                {
                  {
                    qualified: "Qualified for this serving runtime.",
                    runtime_unavailable:
                      "A compatible Engram serving runtime has not been qualified.",
                    module_unavailable: "The original trained memory module is unavailable.",
                    model_mismatch: "The serving runtime differs from this exact base model.",
                  }[value.availability.reason]
                }
              </p>
              <p>Default modification: {value.defaultEnabled ? "Saved memory module" : "Off"}</p>
            </>
          ) : null}
          {value.schemaVersion === "openpond.steeringModelServing.v1" ? (
            <p>Default modification: {value.defaultPublication ? "Saved profile" : "Off"}</p>
          ) : null}
          {value.schemaVersion === "openpond.alphaEditModelServing.v1" ||
          value.schemaVersion === "openpond.neuronTrainingModelServing.v1" ||
          value.schemaVersion === "openpond.decisionModelServing.v1" ? (
            <p>Qualification: {value.availability.reason.replaceAll("_", " ")}</p>
          ) : null}
          {value.control?.failureCode ? (
            <p>
              Recorded serving outcome: <code>{value.control.failureCode}</code>
            </p>
          ) : null}
          {value.pools.length ? (
            <div className="training-table-wrap">
              <table className="training-data-table labs-managed-serving-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Pool state</th>
                    <th>Worker limit</th>
                    <th>Deployments</th>
                    <th>Active requests</th>
                    <th>Pending reconciliation</th>
                    <th>Retirement</th>
                  </tr>
                </thead>
                <tbody>
                  {value.pools.map((pool) => (
                    <tr key={pool.id}>
                      <td>{pool.provider}</td>
                      <td>{pool.state}</td>
                      <td>{pool.workersMax}</td>
                      <td>{pool.activeDeployments}</td>
                      <td>{pool.activeRequests}</td>
                      <td>{pool.unsettledRequests}</td>
                      <td>{pool.retirementBlocked ? "In use" : "No consumers recorded"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {value.cleanup.length ? (
            <div className="training-table-wrap">
              <table className="training-data-table labs-managed-serving-table">
                <caption>Previous serving capacity</caption>
                <thead>
                  <tr>
                    <th>Saved version</th>
                    <th>Request state</th>
                    <th>Capacity</th>
                  </tr>
                </thead>
                <tbody>
                  {value.cleanup.map((row) => (
                    <tr key={row.operationId}>
                      <td>{row.versionHash.slice(0, 12)}</td>
                      <td>{row.phase}</td>
                      <td>
                        {
                          {
                            pending: "Cleanup pending",
                            shared: "Retained for current consumers",
                            retiring: "Retirement in progress",
                            released: "Retirement complete",
                          }[row.capacityState]
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <details>
            <summary>Serving references</summary>
            <pre className="saved-model-version-reference">
              {JSON.stringify(
                {
                  ...value,
                  version:
                    value.schemaVersion === "openpond.trainingModelServing.v1"
                      ? {
                          contentHash: value.version.contentHash,
                          jobId: value.version.jobId,
                          candidate: value.version.candidate,
                        }
                      : value.schemaVersion === "openpond.engramModelServing.v1" ||
                          value.schemaVersion === "openpond.decisionModelServing.v1" ||
                          value.schemaVersion === "openpond.alphaEditModelServing.v1" ||
                          value.schemaVersion === "openpond.neuronTrainingModelServing.v1"
                        ? {
                            contentHash: value.version.contentHash,
                            source: value.version.source,
                            artifact: {
                              id: value.version.artifact.id,
                              contentHash: value.version.artifact.contentHash,
                            },
                          }
                        : {
                            contentHash: value.version.contentHash,
                            publication: {
                              id: value.version.publication.id,
                              revision: value.version.publication.revision,
                              contentHash: value.version.publication.contentHash,
                            },
                          },
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      ) : null}
      {api && version.schemaVersion === "openpond.decisionModelVersion.v1" ? (
        <DecisionModelScoring
          key={`${api.key}:${version.contentHash}`}
          api={api}
          version={version}
          active={
            value?.schemaVersion === "openpond.decisionModelServing.v1" && value.state === "active"
          }
        />
      ) : null}
      {api && review ? (
        <ModelServingControlDialog
          key={`${api.key}:${connectionQueryScope(api.connection)}:${modelProjectId}:${versionHash}`}
          api={api}
          version={version}
          value={query.error ? undefined : value}
          action={review}
          onClose={() => setReview(null)}
        />
      ) : null}
    </section>
  );
}
