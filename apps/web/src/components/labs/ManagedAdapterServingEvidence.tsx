import type {
  ManagedAdapterEvaluationEvidence,
  ManagedAdapterServingProjection,
} from "@openpond/contracts";

import { Download } from "../icons";
import { DetailSection } from "../training/DetailSection";
import { formatDateTime } from "../training/training-model-data";

export function ManagedAdapterServingEvidence({
  projection,
}: {
  projection: ManagedAdapterServingProjection | null;
}) {
  if (!projection) return null;
  const record = projection.servingReceipts[0] ?? null;
  const receipt = record?.receipt ?? null;
  const admissionPassed =
    projection.evaluation?.passed === true
    && projection.evaluation.compatibility.passed;
  const servingState =
    projection.canonicalDeploymentState === "ready"
      ? "Online"
      : receipt
        ? `Offline · proof retained from ${formatDateTime(
            receipt.timestamps.completedAt,
          )}`
        : projection.canonicalDeploymentState
          ? humanize(projection.canonicalDeploymentState)
          : "Not deployed";

  return (
    <DetailSection
      title="Managed Sandbox serving"
      actions={
        <div className="training-table-actions">
          {projection.evaluation ? (
            <button
              className="training-button secondary"
              type="button"
              onClick={() =>
                downloadCanonicalJson(
                  `${projection.canonicalArtifactId ?? projection.sourceRef}-sandbox-evaluation.json`,
                  projection.evaluation,
                )
              }
            >
              <Download size={14} />
              Evaluation receipt
            </button>
          ) : null}
          {record ? (
            <button
              className="training-button secondary"
              type="button"
              onClick={() =>
                downloadCanonicalJson(
                  `${record.requestId}-serving-receipt.json`,
                  record,
                )
              }
            >
              <Download size={14} />
              Serving receipt
            </button>
          ) : null}
          <button
            className="training-button secondary"
            type="button"
            onClick={() =>
              downloadCanonicalJson(
                `${projection.sourceRef}-managed-serving-projection.json`,
                projection,
              )
            }
          >
            <Download size={14} />
            Full projection
          </button>
        </div>
      }
    >
      <p className="training-muted">
        Sandbox compatibility and admission are durable evidence. Serving
        availability is live state, so an intentionally retired GPU can be
        offline without erasing the completed proof.
      </p>
      <dl className="labs-inline-facts">
        <Fact
          label="Sandbox admission"
          value={
            projection.evaluation
              ? admissionPassed
                ? "Passed"
                : "Failed"
              : "Pending"
          }
        />
        <Fact
          label="Artifact"
          value={`${humanize(
            projection.canonicalArtifactState ?? "pending",
          )} · ${shortId(projection.canonicalArtifactId)}`}
        />
        <Fact label="Serving" value={servingState} />
        <Fact
          label="Deployment"
          value={shortId(projection.canonicalDeploymentId)}
        />
        <Fact
          label="Base"
          value={
            receipt
              ? `${receipt.identity.baseRepository} @ ${receipt.identity.baseRevision.slice(
                  0,
                  12,
                )}`
              : projection.baseProfileId ?? "Not recorded"
          }
        />
        <Fact
          label="Alias"
          value={receipt?.identity.requestedAlias ?? "No request proof yet"}
        />
        <Fact
          label="Adapter cache"
          value={
            receipt
              ? receipt.state.adapterCacheHit
                ? "Warm hit"
                : "Cold materialization"
              : "No request proof yet"
          }
        />
        <Fact
          label="vLLM adapter"
          value={
            receipt
              ? String(receipt.identity.appliedVllmAdapterId)
              : "Not recorded"
          }
        />
        <Fact
          label="Time to first token"
          value={formatMilliseconds(receipt?.durationsMs.timeToFirstToken)}
        />
        <Fact
          label="Generation"
          value={formatMilliseconds(receipt?.durationsMs.generation)}
        />
        <Fact
          label="Total request"
          value={formatMilliseconds(receipt?.durationsMs.totalRequest)}
        />
        <Fact
          label="Usage"
          value={
            receipt
              ? `${receipt.usage.inputTokens} in · ${receipt.usage.outputTokens} out · ${receipt.usage.providerUsageSource}`
              : "Not recorded"
          }
        />
        <Fact
          label={
            receipt?.cost.providerReportedUsd === null
              ? "Estimated request cost"
              : "Provider-reported cost"
          }
          value={
            receipt
              ? `$${(
                  receipt.cost.providerReportedUsd
                  ?? receipt.cost.estimatedUsd
                ).toFixed(6)}`
              : "Not recorded"
          }
        />
        <Fact
          label="Pool quote"
          value={
            projection.servingPool?.estimatedHourlyUsd
              ? `$${Number(
                  projection.servingPool.estimatedHourlyUsd,
                ).toFixed(4)}/hour`
              : "Not recorded"
          }
        />
        <Fact
          label="Receipt hash"
          value={receipt?.contentHash ?? "No request proof yet"}
        />
      </dl>
      {projection.lastError ? (
        <p className="labs-training-error">{projection.lastError}</p>
      ) : null}
    </DetailSection>
  );
}

export function ManagedAdapterEvaluationPanel({
  evaluation,
}: {
  evaluation: ManagedAdapterEvaluationEvidence;
}) {
  return (
    <div className="training-run-evaluation">
      <dl className="labs-inline-facts">
        <Fact
          label="Admission"
          value={
            evaluation.passed && evaluation.compatibility.passed
              ? "Passed"
              : "Failed"
          }
        />
        <Fact
          label="Compatibility"
          value={evaluation.compatibility.passed ? "Passed" : "Failed"}
        />
        <Fact label="Role" value={humanize(evaluation.role)} />
        <Fact label="Policy" value={evaluation.policyId} />
        <Fact
          label="Candidate diagnostic"
          value={evaluation.candidateScore.toFixed(4)}
        />
        <Fact
          label="Baseline diagnostic"
          value={evaluation.baselineScore.toFixed(4)}
        />
        <Fact
          label="Worker image"
          value={evaluation.compatibility.workerImageDigest}
        />
        <Fact
          label="Completed"
          value={formatDateTime(evaluation.completedAt)}
        />
        <Fact label="Evidence hash" value={evaluation.evidenceHash} />
      </dl>
      <p className="training-muted">
        This is the Sandbox compatibility and admission receipt. It is
        independent from the product-quality benchmark shown above when one
        exists.
      </p>
      <button
        className="training-button secondary"
        type="button"
        onClick={() =>
          downloadCanonicalJson(
            `${evaluation.evaluationId}-sandbox-evaluation.json`,
            evaluation,
          )
        }
      >
        <Download size={14} />
        Download Sandbox evaluation receipt
      </button>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function shortId(value: string | null): string {
  if (!value) return "Not recorded";
  return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatMilliseconds(value: number | undefined): string {
  return value === undefined ? "Not recorded" : `${value.toFixed(1)} ms`;
}

export function downloadCanonicalJson(
  filename: string,
  value: unknown,
): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
