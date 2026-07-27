import {
  conciseWorkproductName,
  type TaskCreationRequest,
  type TaskCreationSnapshot,
  type TaskDesignProposal,
  type TrainingSourceRef,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

import { crossSystemGroundTruth } from "./task-creator-cross-system.js";

export function proposalMaterializationBlockers(
  proposal: TaskDesignProposal,
  sources: TrainingSourceRef[],
  request: TaskCreationRequest,
): string[] {
  const buildingTypedDataset =
    request.resourceIntent === "dataset" && request.buildSpecification !== null;
  if (!proposal.diagnosis.trainingEligible && !buildingTypedDataset) {
    return [
      `OpenPond recommends ${proposal.diagnosis.intervention.replaceAll("_", " ")} instead of model training.`,
    ];
  }
  const blockers: string[] = [];
  if (
    !buildingTypedDataset &&
    !["sft", "dpo", "grpo", "sdft", "opsd", "sdpo"].includes(
      proposal.proposedMethod,
    )
  ) {
    blockers.push(
      `The ${proposal.proposedMethod.replaceAll("_", " ")} recommendation does not create a trainable Taskset.`,
    );
  }
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const hasGroundTruth = (
    example: TaskDesignProposal["proposedExamples"][number],
  ) =>
    Boolean(
      example.expectedOutputText ||
        crossSystemGroundTruth(sourceById.get(example.sourceId)),
    );
  const train = proposal.proposedExamples.filter(
    (example) =>
      example.split === "train" &&
      (proposal.proposedMethod === "grpo"
        ? hasGroundTruth(example)
        : Boolean(example.expectedOutputText)),
  );
  const frozen = proposal.proposedExamples.filter(
    (example) => example.split === "frozen_eval" && hasGroundTruth(example),
  );
  if (!train.length && !buildingTypedDataset) {
    blockers.push(
      proposal.proposedMethod === "grpo"
        ? "No reviewed reward-bearing training task was proposed."
        : "No reviewed training example was proposed.",
    );
  }
  if (!frozen.length && !buildingTypedDataset) {
    blockers.push("No independent evaluation example was proposed.");
  }
  const clusterSplits = new Map<string, Set<string>>();
  for (const example of proposal.proposedExamples) {
    const cluster = sourceById.get(example.sourceId)?.clusterKey;
    if (!cluster) continue;
    const splits = clusterSplits.get(cluster) ?? new Set<string>();
    splits.add(example.split);
    clusterSplits.set(cluster, splits);
  }
  if (
    !buildingTypedDataset &&
    [...clusterSplits.values()].some((splits) => splits.size > 1)
  ) {
    blockers.push(
      "A source conversation appears in both training and evaluation. Each conversation must remain in one split.",
    );
  }
  const trainClusters = new Set(
    train
      .map((example) => sourceById.get(example.sourceId)?.clusterKey)
      .filter(Boolean),
  );
  const frozenClusters = new Set(
    frozen
      .map((example) => sourceById.get(example.sourceId)?.clusterKey)
      .filter(Boolean),
  );
  if (
    !buildingTypedDataset &&
    (!trainClusters.size ||
      !frozenClusters.size ||
      [...trainClusters].some((cluster) => frozenClusters.has(cluster)))
  ) {
    blockers.push(
      "Training and evaluation require independent source conversations.",
    );
  }
  if (!proposal.proposedGraders.length) {
    blockers.push("No evaluation grader was proposed.");
  }
  const fixtureLabels = new Set(
    proposal.graderFixtures.map((fixture) => fixture.label),
  );
  for (const label of [
    "positive",
    "negative",
    "boundary",
    "adversarial",
    "prompt_injection",
    "infrastructure_failure",
  ] as const) {
    if (!fixtureLabels.has(label)) {
      blockers.push(
        `The grader is missing its ${label.replaceAll("_", " ")} fixture.`,
      );
    }
  }
  return [...new Set(blockers)];
}

export function trainingPathForProposal(
  proposal:
    | Pick<TaskDesignProposal, "proposedMethod" | "proposedExamples">
    | Record<string, unknown>,
) {
  const method = proposal.proposedMethod;
  if (
    method !== "sft" &&
    method !== "dpo" &&
    method !== "grpo" &&
    method !== "sdft" &&
    method !== "opsd" &&
    method !== "sdpo"
  ) {
    return null;
  }
  const examples = Array.isArray(proposal.proposedExamples)
    ? (proposal.proposedExamples as TaskDesignProposal["proposedExamples"])
    : [];
  const demonstrationRefs = examples
    .filter(
      (example) =>
        example.split === "train" && Boolean(example.expectedOutputText),
    )
    .map((example) => example.id);
  return {
    primaryMethod: method,
    bootstrap:
      method === "grpo" && demonstrationRefs.length
        ? {
            method: "sft" as const,
            purpose: "trajectory_bootstrap" as const,
            demonstrationRefs,
            limitations: [
              "The SFT bootstrap imitates approved trajectories; it does not optimize verifier reward.",
              "Completing the bootstrap does not satisfy the primary GRPO recommendation.",
            ],
          }
        : null,
  };
}

export function assertProposalMaterializable(
  proposal: TaskDesignProposal,
  sources: TrainingSourceRef[],
  request: TaskCreationRequest,
): void {
  const blockers = proposalMaterializationBlockers(proposal, sources, request);
  if (blockers.length) throw new Error(blockers[0]);
}

export function conciseTasksetName(objective: string): string {
  return conciseWorkproductName(
    objective.replace(/[^a-zA-Z0-9 ]/g, " "),
    "Training Taskset",
  );
}

export function materializedTasksetId(
  snapshot: TaskCreationSnapshot,
  proposal: TaskDesignProposal,
): string {
  if (
    snapshot.request.resourceIntent === "dataset" &&
    snapshot.request.targetIntent.operation === "improve"
  ) {
    if (!snapshot.request.targetIntent.id) {
      throw new Error("Editing a Dataset requires its existing Dataset ID.");
    }
    return snapshot.request.targetIntent.id;
  }
  return safeTasksetId(proposal.name, snapshot.id);
}

function safeTasksetId(name: string, snapshotId: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "taskset";
  return `${slug}-${contentHash(snapshotId).slice(0, 8)}`;
}
