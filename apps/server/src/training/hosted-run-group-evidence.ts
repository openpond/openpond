import type { RunStageEvidence } from "@openpond/contracts";
import type { HostedStageDetail } from "./hosted-run-stage-evidence.js";
import { stageDiagnostics, stageFeedbackTargets } from "./hosted-run-diagnostics.js";

/** Group snapshots use retained receipt links within this run. Commands have no group identity. */
export function groupStageEvidence(
  detail: HostedStageDetail,
  groupId: string,
  live: boolean,
): RunStageEvidence["nodes"] {
  const group = detail.rolloutGroups.find((row) => row.id === groupId);
  if (!group) return [];
  const rollouts = detail.rollouts.filter((row) => row.groupId === groupId);
  const rolloutIds = new Set(rollouts.map((row) => row.id));
  const trajectories = detail.trajectories.filter((row) => rolloutIds.has(row.rolloutId));
  const stepIds = new Set(
    trajectories
      .map((row) => row.consumedTrainingStepId)
      .filter((value) => typeof value === "string"),
  );
  const trainingSteps = detail.trainingSteps.filter(
    (row) => row.groupId === groupId || stepIds.has(row.id),
  );
  const versions = new Set(
    trainingSteps.flatMap((row) =>
      typeof row.optimizerCommitSha256 === "string" &&
      row.optimizerCommitSha256.length > 0 &&
      row.inputPolicyVersion !== undefined &&
      row.outputPolicyVersion !== undefined &&
      row.outputPolicyVersion > row.inputPolicyVersion
        ? [row.outputPolicyVersion]
        : [],
    ),
  );
  const checkpoints = detail.checkpoints.filter(
    (row) => typeof row.policyVersion === "number" && versions.has(row.policyVersion),
  );
  const policyVersions = detail.policyVersions.filter((row) => versions.has(row.version));
  const scoped: HostedStageDetail = {
    ...detail,
    rolloutGroups: [group],
    rollouts,
    trajectories,
    trainingSteps,
    checkpoints,
    policyVersions,
    commands: [],
    evaluations: [],
  };
  const graded = trajectories.filter(
    (row) => row.reward !== null && Number.isFinite(Number(row.reward)),
  ).length;
  const committed = trainingSteps.filter(
    (row) => typeof row.optimizerCommitSha256 === "string" && row.optimizerCommitSha256.length > 0,
  ).length;
  const failure = (states: string[]) =>
    states.some((state) => /failed|cancelled|timed_out|expired/.test(state));
  const definitions = [
    {
      label: "Rollouts",
      done: ["scoring", "eligible", "consumed"].includes(group.state),
      active: group.state === "running",
      failed: failure(rollouts.map((row) => row.state)),
      detail: `${rollouts.length} retained attempts`,
    },
    {
      label: "Grade",
      done: ["eligible", "consumed"].includes(group.state),
      active: group.state === "scoring",
      failed: trajectories.some((row) =>
        ["grader_failure", "validation_failure", "infrastructure_failure"].includes(
          String(row.terminalClass),
        ),
      ),
      detail: `${graded} graded${group.rewardMean === null ? "" : ` · avg ${Number(group.rewardMean).toFixed(3)}`}`,
    },
    {
      label: "Update adapter",
      done: committed > 0,
      active: trainingSteps.some((row) => ["running", "leased"].includes(row.state)),
      failed: failure(trainingSteps.map((row) => row.state)),
      detail: group.optimizerDisposition === "skipped_no_signal" ? `No optimizer update · policy v${group.policyVersion}` : `${committed} optimizer commit${committed === 1 ? "" : "s"} · ${trainingSteps.length} linked step${trainingSteps.length === 1 ? "" : "s"}`,
    },
    {
      label: "Save checkpoint",
      done: checkpoints.some((row) => row.state === "ready" && Boolean(row.adapterSha256)),
      active: false,
      failed: failure(checkpoints.flatMap((row) => (row.state ? [row.state] : []))),
      detail: `${checkpoints.filter(row => row.state === "ready" && row.adapterSha256).length} durable · ${checkpoints.length} checkpoint receipts`,
    },
    {
      label: "Activate policy",
      done: policyVersions.some((row) => row.served),
      active: false,
      failed: false,
      detail: policyVersions.some((row) => row.served)
        ? `Serving v${policyVersions.find((row) => row.served)!.version}`
        : "No linked serving attestation",
    },
  ];
  return definitions
    .filter(
      (row) =>
        detail.job.inputBundle?.executionIntent?.purpose !== "collection" ||
        ["Rollouts", "Grade"].includes(row.label),
    )
    .map((row) => ({
      label: row.label,
      inLoop: true,
      state: row.failed
        ? "failed"
        : row.done
          ? "done"
          : live && row.active
            ? "active"
            : live
              ? "pending"
              : "missing",
      status: row.label === "Update adapter" && group.optimizerDisposition === "skipped_no_signal" ? "Skipped · no signal" : row.failed
        ? "Issues recorded"
        : row.done
          ? "Recorded"
          : live && row.active
            ? "In progress"
            : "Not recorded",
      detail: row.detail,
      diagnostics: stageDiagnostics(scoped, row.label),
      feedback: stageFeedbackTargets(scoped, row.label),
    }));
}
