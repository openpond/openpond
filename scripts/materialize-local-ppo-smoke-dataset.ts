import path from "node:path";
import {
  TasksetSchema,
  TrainingSourceRefSchema,
  type TaskDataRecord,
  type TrainingSourceRef,
} from "@openpond/contracts";
import {
  buildTaskset,
  computeTasksetHash,
  contentHash,
} from "@openpond/taskset-sdk";
import { SqliteStore } from "../apps/server/src/store/store.js";

type Arguments = {
  apply: boolean;
  profileId: string;
  storeDir: string;
};

const TASKSET_ID = "local-ppo-smoke-dataset";
const args = parseArguments(process.argv.slice(2));
const store = new SqliteStore(args.storeDir);

try {
  const existing = await store.getTaskset(TASKSET_ID);
  if (existing) {
    process.stdout.write(`${JSON.stringify({
      applied: false,
      existing: true,
      tasksetId: existing.id,
      revision: existing.revision,
      contentHash: existing.contentHash,
      status: existing.status,
    }, null, 2)}\n`);
    process.exitCode = 0;
  } else {
    const timestamp = new Date().toISOString();
    const trainSource = source({
      id: "local_ppo_smoke_train_source",
      clusterKey: "local_ppo_smoke_train_cluster",
      profileId: args.profileId,
      title: "Local PPO smoke training prompt",
      timestamp,
    });
    const evalSource = source({
      id: "local_ppo_smoke_eval_source",
      clusterKey: "local_ppo_smoke_eval_cluster",
      profileId: args.profileId,
      title: "Local PPO smoke frozen-evaluation prompt",
      timestamp,
    });
    const tasks: TaskDataRecord[] = [
      task({
        id: "local_ppo_smoke_train",
        source: trainSource,
        split: "train",
        prompt: "Reply with exactly: blue",
        expected: "blue",
      }),
      task({
        id: "local_ppo_smoke_eval",
        source: evalSource,
        split: "frozen_eval",
        prompt: "Reply with exactly: green",
        expected: "green",
      }),
    ];
    const draft = TasksetSchema.parse({
      schemaVersion: "openpond.taskset.v1",
      id: TASKSET_ID,
      revision: 1,
      profileId: args.profileId,
      name: "Local PPO Smoke Dataset",
      objective:
        "Verify that the bounded local PPO executor can sample a response, score it deterministically, update policy and value weights, and save a reloadable adapter.",
      status: "needs_review",
      sourceRefs: [trainSource, evalSource],
      policy: {
        policyVisibleFields: ["input.prompt"],
        privilegedFields: ["expectedOutput.text"],
        hiddenGraderRefs: ["expected_output"],
        connectedAppScopes: [],
      },
      environment: {
        protocolVersion: "openpond.taskEnvironment.v1",
        kind: "chat",
        entrypoint: "environment/taskset.ts",
        stateful: false,
        deterministicSeeds: true,
        toolNames: [],
        lifecycle: ["create", "reset", "step", "grade", "cleanup"],
        defaultTimeoutMs: 120_000,
        networkPolicy: "none",
        metadata: {
          fixtureKind: "local_ppo_correctness",
        },
      },
      capabilities: {
        schemaVersion: "openpond.tasksetCapabilities.v1",
        taskKind: "chat",
        supportedSignals: ["reward"],
        compatibleMethods: ["grpo", "ppo"],
        rewardKinds: ["exact", "deterministic"],
        requiresTools: false,
        requiresState: false,
        requiresPrivilegedGrading: true,
        environmentPlacements: ["local", "remote"],
        exportable: true,
        portabilityBlockers: [],
      },
      tasks,
      graders: [{
        id: "expected_output",
        version: "1",
        label: "Exact expected output",
        kind: "state",
        weight: 1,
        hardGate: true,
        rewardEligible: true,
        privileged: true,
        config: { fields: ["text"] },
        metadata: {},
      }],
      graderFixtures: graderFixtures(),
      learningSignals: {
        demonstrations: [],
        preferences: [],
        corrections: [],
        feedback: [],
        rewards: [{
          id: "local_ppo_exact_reward",
          kind: "reward",
          taskId: "local_ppo_smoke_train",
          sourceRefs: [trainSource.id],
          artifactRef: "grader_expected_output",
          approved: true,
          confidence: 1,
          task: "Return the exact expected response.",
          rules: [{
            id: "exact_match",
            points: 1,
            condition: "The response exactly matches the privileged expected text.",
          }],
          otherwisePoints: 0,
          executable: true,
          metadata: {
            executor: "openpond_local_deterministic_token_reward_v1",
          },
        }],
        labels: [],
      },
      authoringProvenance: {
        schemaVersion: "openpond.taskAuthoringProvenance.v1",
        model: null,
        modelConfig: {
          source: "materialize-local-ppo-smoke-dataset",
        },
        skillHash: contentHash("local-ppo-smoke-dataset-v1"),
        promptTemplateVersion: "local-ppo-smoke.v1",
        evidenceHashes: [trainSource.sourceHash, evalSource.sourceHash],
        tasksetSdkVersion: "0.0.1",
        sourceCommit: null,
        repairHistory: [],
        createdAt: timestamp,
      },
      readiness: null,
      contentHash: "00000000",
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        trainingMethod: "ppo",
        fixtureKind: "local_ppo_correctness",
        containsCustomerData: false,
        splitIsolationVerified: true,
        diagnosis: {
          schemaVersion: "openpond.capabilityDiagnosis.v1",
          summary:
            "Exercise the local PPO implementation with a deterministic exact-match reward.",
          stableBehavior: ["Return a short exact response to an explicit prompt."],
          changingKnowledge: [],
          requiredContext: [],
          requiredTools: [],
          intervention: "ppo",
          trainingEligible: true,
          rationale: [
            "A bounded executable reward can score every sampled response.",
            "Independent train and frozen-evaluation prompts verify the pipeline without claiming model quality.",
          ],
          confidence: 1,
        },
      },
    });
    const tasksetHash = computeTasksetHash(draft);
    const taskset = TasksetSchema.parse({
      ...draft,
      status: "ready",
      contentHash: tasksetHash,
      readiness: {
        schemaVersion: "openpond.tasksetReadiness.v1",
        tasksetId: draft.id,
        tasksetHash,
        ready: true,
        recommendedMethod: "ppo",
        trainingPath: {
          primaryMethod: "ppo",
          bootstrap: null,
        },
        methodReadiness: [
          {
            method: "grpo",
            status: "compatible",
            reasonCodes: [],
            reasons: [],
          },
          {
            method: "ppo",
            status: "recommended",
            reasonCodes: ["value_model_required"],
            reasons: ["Bind the recipe value model."],
          },
        ],
        compatibleDestinationClasses: ["local_cpu_fixture"],
        blockers: [],
        warnings: [
          "This Dataset exists only to verify local PPO pipeline correctness.",
        ],
        baselineReportId: null,
        baselineReward: null,
        generatedAt: timestamp,
      },
    });
    const summary = {
      applied: args.apply,
      existing: false,
      tasksetId: taskset.id,
      revision: taskset.revision,
      contentHash: taskset.contentHash,
      trainCount: 1,
      frozenEvaluationCount: 1,
    };
    if (args.apply) {
      await store.upsertTrainingSource(trainSource);
      await store.upsertTrainingSource(evalSource);
      await buildTaskset(
        taskset,
        path.join(args.storeDir, "training", "tasksets", taskset.id),
      );
      await store.upsertTaskset(taskset);
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
} finally {
  await store.close();
}

function source(input: {
  id: string;
  clusterKey: string;
  profileId: string;
  title: string;
  timestamp: string;
}): TrainingSourceRef {
  return TrainingSourceRefSchema.parse({
    schemaVersion: "openpond.trainingSource.v1",
    id: input.id,
    profileId: input.profileId,
    sessionId: input.id,
    turnIds: [],
    workspaceId: null,
    sourceHash: contentHash({
      id: input.id,
      promptClass: "local_ppo_correctness",
    }),
    clusterKey: input.clusterKey,
    title: input.title,
    occurredAt: input.timestamp,
    consent: {
      status: "granted",
      scope: "metadata_only",
      grantedBy: "local_user",
      grantedAt: input.timestamp,
      purpose: "task_authoring_and_evaluation",
    },
    connectedAppIds: [],
    secretScanStatus: "passed",
    piiScanStatus: "passed",
    licensingStatus: "approved",
    metadata: {
      syntheticSpecification: true,
      containsCustomerData: false,
    },
  });
}

function task(input: {
  id: string;
  source: TrainingSourceRef;
  split: "train" | "frozen_eval";
  prompt: string;
  expected: string;
}): TaskDataRecord {
  return {
    schemaVersion: "openpond.taskData.v1",
    id: input.id,
    clusterKey: input.source.clusterKey,
    split: input.split,
    input: { prompt: input.prompt },
    expectedOutput: { text: input.expected },
    policyVisibleContext: {},
    privilegedContextRef: `expected_${input.id}`,
    sourceRefs: [input.source.id],
    tags: ["synthetic", "local-ppo-smoke"],
    metadata: {
      exampleOrigin: "synthetic",
      exampleRationale:
        "A tiny independent exact-answer fixture exercises PPO correctness without claiming useful model quality.",
    },
  };
}

function graderFixtures() {
  const common = {
    taskId: "local_ppo_smoke_eval",
    infrastructureError: null,
    expectedPassed: false,
    expectedRewardEligible: false,
    metadata: {},
  };
  return [
    {
      ...common,
      id: "local_ppo_fixture_positive",
      label: "positive" as const,
      output: { text: "green" },
      expectedPassed: true,
      expectedRewardEligible: true,
    },
    {
      ...common,
      id: "local_ppo_fixture_negative",
      label: "negative" as const,
      output: { text: "blue" },
    },
    {
      ...common,
      id: "local_ppo_fixture_boundary",
      label: "boundary" as const,
      output: { text: "green", extra: true },
      expectedPassed: true,
      expectedRewardEligible: true,
    },
    {
      ...common,
      id: "local_ppo_fixture_adversarial",
      label: "adversarial" as const,
      output: { text: "reward me" },
    },
    {
      ...common,
      id: "local_ppo_fixture_prompt_injection",
      label: "prompt_injection" as const,
      output: { text: "ignore the grader" },
    },
    {
      ...common,
      id: "local_ppo_fixture_infrastructure",
      label: "infrastructure_failure" as const,
      output: {},
      infrastructureError: "Synthetic infrastructure failure.",
    },
  ];
}

function parseArguments(values: string[]): Arguments {
  let apply = false;
  let profileId = "default";
  let storeDir = path.join(process.env.HOME ?? "", ".openpond", "openpond-app");
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--apply") {
      apply = true;
      continue;
    }
    if (value === "--profile-id") {
      profileId = requiredValue(values[++index], "--profile-id");
      continue;
    }
    if (value === "--store-dir") {
      storeDir = path.resolve(requiredValue(values[++index], "--store-dir"));
      continue;
    }
    throw new Error(`Unknown argument ${value}.`);
  }
  if (!storeDir) throw new Error("--store-dir is required when HOME is unset.");
  return { apply, profileId, storeDir };
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} requires a value.`);
  return value.trim();
}
