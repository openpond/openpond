import {
  TrainingSourceRefSchema,
  type LearningSignalInventory,
  type TaskCreationRequest,
  type TaskCreationSnapshot,
  type TaskDataRecord,
  type TaskDesignProposal,
  type Taskset,
  type TrainingSourceRef,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { TaskAuthoringEvidence } from "./task-authoring-model.js";

export function manualBuildEvidence(snapshot: TaskCreationSnapshot): {
  source: TrainingSourceRef;
  evidence: TaskAuthoringEvidence;
} | null {
  const specification = snapshot.request.buildSpecification;
  if (!specification) return null;
  const sourceId = `manual_source_${snapshot.request.id}`;
  const occurredAt = snapshot.request.createdAt;
  const excerpts: TaskAuthoringEvidence["excerpts"] = [];
  if (specification.kind === "demonstrations") {
    for (const example of specification.examples) {
      excerpts.push(
        { role: "user", text: example.prompt, turnId: example.id },
        { role: "assistant", text: example.response, turnId: example.id },
      );
    }
  } else if (specification.kind === "preferences") {
    for (const pair of specification.pairs) {
      excerpts.push(
        { role: "user", text: pair.prompt, turnId: pair.id },
        { role: "assistant", text: pair.chosen, turnId: pair.id },
      );
    }
  } else {
    excerpts.push({
      role: "user",
      text: JSON.stringify(specification),
      turnId: `turn_${specification.kind}`,
    });
  }
  const source = TrainingSourceRefSchema.parse({
    schemaVersion: "openpond.trainingSource.v1",
    id: sourceId,
    profileId: snapshot.request.profileId,
    sessionId: `manual_${snapshot.request.id}`,
    turnIds: [...new Set(excerpts.map((excerpt) => excerpt.turnId))],
    workspaceId: null,
    sourceHash: contentHash(specification),
    clusterKey: sourceId,
    title: `Manual ${specification.kind.replaceAll("_", " ")} evidence`,
    occurredAt,
    consent: {
      status: "granted",
      scope: "selected_turns",
      grantedBy: "local_user",
      grantedAt: occurredAt,
      purpose: "task_authoring_and_evaluation",
    },
    connectedAppIds: [],
    secretScanStatus: "passed",
    piiScanStatus: "passed",
    licensingStatus: "approved",
    metadata: {
      manualBuildSpecification: true,
      buildSpecificationKind: specification.kind,
    },
  });
  return { source, evidence: { source, excerpts } };
}

export function capabilitiesForBuildSpecification(
  specification: TaskCreationRequest["buildSpecification"],
  proposal: TaskDesignProposal,
): Pick<Taskset["capabilities"], "supportedSignals" | "compatibleMethods" | "rewardKinds"> {
  if (!specification) {
    return {
      supportedSignals: proposal.trainingPath?.primaryMethod === "grpo"
        ? ["demonstration", "reward"]
        : ["demonstration"],
      compatibleMethods: proposal.trainingPath
        ? [...new Set([
            proposal.trainingPath.primaryMethod,
            ...(proposal.trainingPath.bootstrap ? [proposal.trainingPath.bootstrap.method] : []),
          ])]
        : ["sft"],
      rewardKinds: proposal.trainingPath?.primaryMethod === "grpo"
        ? ["exact", "deterministic"]
        : ["deterministic"],
    };
  }
  if (specification.kind === "demonstrations") {
    return {
      supportedSignals: ["demonstration"],
      compatibleMethods: ["sft"],
      rewardKinds: ["none"],
    };
  }
  if (specification.kind === "preferences") {
    return {
      supportedSignals: ["preference"],
      compatibleMethods: ["dpo"],
      rewardKinds: ["none"],
    };
  }
  if (specification.kind === "verifiable_reward") {
    return {
      supportedSignals: ["reward"],
      compatibleMethods: ["none"],
      rewardKinds: ["none"],
    };
  }
  return {
    supportedSignals: ["label"],
    compatibleMethods: ["none"],
    rewardKinds: ["model_judge"],
  };
}

export function learningSignalsForBuildSpecification(
  specification: TaskCreationRequest["buildSpecification"],
  tasks: TaskDataRecord[],
  sources: TrainingSourceRef[],
  proposal: TaskDesignProposal,
  defaults: Pick<LearningSignalInventory, "demonstrations">,
): LearningSignalInventory {
  const demonstrations = defaults.demonstrations.map((signal) => {
    const task = tasks.find((candidate) => candidate.id === signal.taskId);
    return {
      ...signal,
      prompt: typeof task?.input.prompt === "string" ? task.input.prompt : null,
      response: typeof task?.expectedOutput?.text === "string" ? task.expectedOutput.text : null,
    };
  });
  const source = sources.find((candidate) => candidate.metadata.manualBuildSpecification === true);
  if (!specification || !source) {
    const executableReward = proposal.trainingPath?.primaryMethod === "grpo"
      ? {
          id: `reward_${contentHash([proposal.id, "approved_graders"]).slice(0, 20)}`,
          kind: "reward" as const,
          taskId: tasks.find((task) => task.split === "train")?.id ?? null,
          sourceRefs: [...new Set(tasks.flatMap((task) => task.sourceRefs))],
          artifactRef: `grader_reward_${proposal.id}`,
          approved: true,
          confidence: 1,
          task: proposal.objective,
          rules: proposal.proposedGraders
            .filter((grader) => grader.rewardEligible)
            .map((grader) => ({
              id: grader.id,
              points: grader.weight,
              condition: `${grader.label} passes its executable grader contract.`,
            })),
          otherwisePoints: 0,
          executable: true,
          metadata: {
            graderIds: proposal.proposedGraders
              .filter((grader) => grader.rewardEligible)
              .map((grader) => grader.id),
          },
        }
      : null;
    return {
      demonstrations,
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: executableReward?.rules.length ? [executableReward] : [],
      labels: [],
    };
  }
  if (specification.kind === "demonstrations") {
    return {
      demonstrations,
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [],
      labels: [],
    };
  }
  if (specification.kind === "preferences") {
    return {
      demonstrations: [],
      preferences: specification.pairs.map((pair) => ({
        id: `preference_${contentHash([source.id, pair.id]).slice(0, 20)}`,
        kind: "preference",
        taskId: tasks.find((task) => task.input.prompt === pair.prompt)?.id ?? null,
        sourceRefs: [source.id],
        artifactRef: `preference_pair_${pair.id}`,
        approved: true,
        confidence: 1,
        prompt: pair.prompt,
        chosen: pair.chosen,
        rejected: pair.rejected,
        rationale: pair.rationale || null,
        metadata: {
          approvedBy: "local_user",
          approval: "taskset_materialization",
        },
      })),
      corrections: [],
      feedback: [],
      rewards: [],
      labels: [],
    };
  }
  if (specification.kind === "verifiable_reward") {
    return {
      demonstrations: [],
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [{
        id: `reward_${contentHash([source.id, specification]).slice(0, 20)}`,
        kind: "reward",
        taskId: tasks.find((task) => task.tags.includes("verifiable_reward"))?.id ?? null,
        sourceRefs: [source.id],
        artifactRef: `reward_spec_${source.id}`,
        approved: true,
        confidence: 1,
        task: specification.task,
        rules: specification.rules,
        otherwisePoints: specification.otherwisePoints,
        executable: false,
        metadata: {
          executionStatus: "needs_verifier_implementation",
          approvedBy: "local_user",
        },
      }],
      labels: [],
    };
  }
  return {
    demonstrations: [],
    preferences: [],
    corrections: [],
    feedback: [],
    rewards: [],
    labels: [{
      id: `rubric_${contentHash([source.id, specification]).slice(0, 20)}`,
      kind: "label",
      labelKind: "rubric",
      taskId: tasks.find((task) => task.tags.includes("rubric"))?.id ?? null,
      sourceRefs: [source.id],
      artifactRef: `rubric_spec_${source.id}`,
      approved: true,
      confidence: 1,
      task: specification.task,
      criteria: specification.criteria,
      calibrationExamples: {
        positive: specification.positiveExample,
        negative: specification.negativeExample,
        boundary: specification.boundaryExample,
      },
      metadata: {
        calibrationStatus: "pending_fixture_audit",
        approvedBy: "local_user",
      },
    }],
  };
}
