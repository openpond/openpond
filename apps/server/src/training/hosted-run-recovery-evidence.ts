import type { RunStageEvidence } from "@openpond/contracts";
import type { HostedStageDetail } from "./hosted-run-stage-evidence.js";

type Fact = NonNullable<RunStageEvidence["nodes"][number]["diagnostics"]>[number];
const fact = (label: string, value: string | number): Fact => ({
  label: label.slice(0, 200),
  value: String(value).slice(0, 12000),
  severity: "info",
});
/** Source receipts expose only optimizer identity, policy and scores; never child execution records. */
export function optimizerReceiptFacts(evidence: Record<string, unknown>): Fact[] {
  return [
    ...[
      "schemaVersion",
      "trainingStepId",
      "inputPolicyVersion",
      "outputPolicyVersion",
      "localPolicyTransitionSha256",
      "contentHash",
      "normalization",
      "advantageEpsilon",
    ].flatMap((key) =>
      ["string", "number"].includes(typeof evidence[key])
        ? [fact(key, evidence[key] as string | number)]
        : [],
    ),
    ...(Array.isArray(evidence.scores)
      ? evidence.scores.slice(0, 128).flatMap((value) => {
          if (
            !value ||
            typeof value !== "object" ||
            !("rolloutId" in value) ||
            typeof value.rolloutId !== "string"
          )
            return [];
          return [
            fact(
              `Source rollout ${value.rolloutId}`,
              "reward" in value && typeof value.reward === "number"
                ? `Reward ${value.reward}`
                : "Reward not retained",
            ),
          ];
        })
      : []),
  ].slice(0, 95);
}
export function inheritedRecoveryGroups(detail: HostedStageDetail): RunStageEvidence["groups"] {
  const recovery = detail.job.inputBundle?.recovery;
  if (!recovery?.groups) return [];
  const native = new Set(detail.rolloutGroups.map((group) => group.groupIndex));
  return recovery.groups
    .filter((group) => group.groupIndex < recovery.completedGroups && !native.has(group.groupIndex))
    .map((group) => {
      const applied = group.optimizerDisposition === "applied";
      const output =
        typeof group.optimizerEvidence.outputPolicyVersion === "number"
          ? group.optimizerEvidence.outputPolicyVersion
          : undefined;
      const transition =
        applied && output !== undefined
          ? `v${group.policyVersion} → v${output}`
          : `Policy v${group.policyVersion} unchanged`;
      const facts = [
        fact("Evidence origin", "Inherited from checkpoint recovery; not re-executed in this run"),
        fact("Source run", group.sourceJobId),
        fact("Source group", group.id),
        fact("Recovery checkpoint", recovery.checkpointId),
        fact("Retained state", group.state),
        fact("Optimizer outcome", applied ? "Update applied" : "Skipped · no signal"),
        ...optimizerReceiptFacts(group.optimizerEvidence),
      ].slice(0, 100);
      const nodes: RunStageEvidence["nodes"] = [
        ...["Rollouts", "Grade"].map((label) => ({
          label,
          state: "done" as const,
          status: "Inherited",
          detail: "Consumed in source run",
          inLoop: true,
          diagnostics: facts,
        })),
        {
          label: "Update adapter",
          state: applied ? "done" : "missing",
          status: applied ? "Inherited update" : "Skipped · no signal",
          detail: transition,
          inLoop: true,
          diagnostics: facts,
        },
        ...["Save checkpoint", "Activate policy"].map((label) => ({
          label,
          state: "missing" as const,
          status: "Source evidence",
          detail: "Inspect the source run",
          inLoop: true,
          diagnostics: facts,
        })),
      ];
      return {
        index: group.groupIndex,
        state: group.state,
        optimizerDisposition: group.optimizerDisposition,
        inherited: {
          sourceJobId: group.sourceJobId,
          checkpointId: recovery.checkpointId,
          checkpointJobId: recovery.checkpointJobId ?? recovery.sourceJobId,
          optimizerDisposition: group.optimizerDisposition,
          inputPolicyVersion: group.policyVersion,
          ...(output !== undefined ? { outputPolicyVersion: output } : {}),
        },
        meanReward: null,
        plannedSlots: 0,
        attempts: [],
        diagnostics: facts,
        nodes,
      };
    });
}

export function recoveryReplayOrigins(detail: HostedStageDetail) {
  const recovery = detail.job.inputBundle?.recovery;
  return (
    recovery?.undurableProgress?.groups.map((group) => ({
      sourceJobId: group.sourceJobId,
      checkpointId: recovery.checkpointId,
      checkpointJobId: recovery.checkpointJobId ?? recovery.sourceJobId,
      groupId: group.id,
      groupIndex: group.groupIndex,
      optimizerDisposition: group.optimizerDisposition,
      inputPolicyVersion: group.policyVersion,
      ...(typeof group.optimizerEvidence.outputPolicyVersion === "number"
        ? { outputPolicyVersion: group.optimizerEvidence.outputPolicyVersion }
        : {}),
    })) ?? []
  );
}
export function pendingReplayGroups(detail: HostedStageDetail): RunStageEvidence["groups"] {
  const native = new Set(detail.rolloutGroups.map((group) => group.groupIndex));
  return recoveryReplayOrigins(detail)
    .filter((origin) => !native.has(origin.groupIndex))
    .map((origin) => {
      const prior = detail.job.inputBundle!.recovery!.undurableProgress!.groups.find(
        (group) => group.id === origin.groupId,
      )!;
      const diagnostics = [
        fact(
          "Replay boundary",
          "Prior output was not checkpoint durable and was not restored. Replay is required.",
        ),
        fact("Prior attempt source run", origin.sourceJobId),
        fact("Prior source group", origin.groupId),
        ...optimizerReceiptFacts(prior.optimizerEvidence),
      ];
      return {
        index: origin.groupIndex,
        state: "replay_pending",
        replay: origin,
        meanReward: null,
        plannedSlots: 0,
        attempts: [],
        diagnostics,
        nodes: ["Rollouts", "Grade", "Update adapter", "Save checkpoint", "Activate policy"].map(
          (label) => ({
            label,
            inLoop: true,
            state: detail.job.state === "failed" ? ("missing" as const) : ("pending" as const),
            status: "Replay pending",
            detail: "Prior output not restored",
            diagnostics,
          }),
        ),
      };
    });
}
