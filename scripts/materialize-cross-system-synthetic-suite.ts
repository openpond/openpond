import path from "node:path";
import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  DEFAULT_CROSS_SYSTEM_WORLD_SPECS,
  CrossSystemWorldSpecSchema,
  TaskDesignProposalSchema,
  TasksetSchema,
  TrainingSourceRefSchema,
  type CrossSystemTaskFamily,
  type CrossSystemWorldSpec,
  type TaskDataRecord,
  type TrainingSourceRef,
} from "@openpond/contracts";
import {
  buildTaskset,
  computeTasksetHash,
  contentHash,
} from "@openpond/taskset-sdk";
import { SqliteStore } from "../apps/server/src/store/store.js";
import {
  crossSystemGeneratedTaskFiles,
  generateCrossSystemTasks,
  generateCrossSystemWorld,
} from "../apps/server/src/training/cross-system-operations/index.js";

type Arguments = {
  apply: boolean;
  storeDir: string;
  suite: "balanced" | "renewal-risk-v2";
  tasksetId: string;
};

const FAMILY_ORDER: CrossSystemTaskFamily[] = [
  "renewal_exposure",
  "collections_prioritization",
  "invoice_reconciliation",
  "sla_escalation",
  "contract_billing_mismatch",
];

const args = parseArguments(process.argv.slice(2));
const store = new SqliteStore(args.storeDir);

try {
  const taskset = await store.getTaskset(args.tasksetId);
  if (!taskset) throw new Error(`Taskset ${args.tasksetId} was not found.`);
  if (taskset.metadata.flagship !== "cross-system-operations") {
    throw new Error("Only the versioned Cross-System Operations Taskset can use this suite.");
  }
  if (taskset.metadata.toolContractHash !== CROSS_SYSTEM_TOOL_CONTRACT_HASH) {
    throw new Error("The Taskset tool contract does not match the current synthetic suite.");
  }
  const [plans, jobs] = await Promise.all([
    store.listTrainingPlans(),
    store.listTrainingJobs(),
  ]);
  const planIds = new Set(
    plans.filter((plan) => plan.tasksetId === taskset.id).map((plan) => plan.id),
  );
  const activeJob = jobs.find(
    (job) =>
      planIds.has(job.planId)
      && ["queued", "starting", "running", "cancelling", "reconciling"]
        .includes(job.status),
  );
  if (activeJob) {
    throw new Error(
      `Training job ${activeJob.id} is active. Wait for it before revising the Taskset.`,
    );
  }

  const worldSpecs = selectedWorldSpecs(args.suite);
  const worlds = worldSpecs.map(generateCrossSystemWorld);
  const worldById = new Map(worlds.map((world) => [world.id, world]));
  const generatedTasks = worlds.flatMap(generateCrossSystemTasks);
  const selectedFamilies =
    args.suite === "renewal-risk-v2"
      ? (["renewal_exposure"] satisfies CrossSystemTaskFamily[])
      : FAMILY_ORDER;
  const selectedTasks = worlds.flatMap((world) =>
    selectedFamilies.map((family, familyIndex) => {
      const variant = Math.abs(world.seed + familyIndex) % 3;
      const task = generatedTasks.find(
        (candidate) =>
          candidate.worldId === world.id
          && candidate.family === family
          && candidate.phrasingVariant === variant,
      );
      if (!task) {
        throw new Error(
          `Synthetic task ${world.id}/${family}/variant-${variant} was not generated.`,
        );
      }
      return task;
    }),
  );
  const timestamp = new Date().toISOString();
  const sources = selectedTasks.map((task): TrainingSourceRef => {
    const world = worldById.get(task.worldId);
    if (!world) throw new Error(`Synthetic world ${task.worldId} was not found.`);
    const suffix = contentHash([taskset.id, task.id]).slice(0, 24);
    return TrainingSourceRefSchema.parse({
      schemaVersion: "openpond.trainingSource.v1",
      id: `synthetic_source_${suffix}`,
      profileId: taskset.profileId,
      sessionId: `synthetic_scenario_${suffix}`,
      turnIds: [],
      workspaceId: null,
      sourceHash: contentHash({
        schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
        generatorVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
        task,
      }),
      clusterKey: task.worldId,
      title: `Synthetic CRM scenario: ${familyLabel(task.family)}`,
      occurredAt: timestamp,
      consent: {
        status: "granted",
        scope: "metadata_only",
        grantedBy: "local_user",
        grantedAt: timestamp,
        purpose: "task_authoring_and_evaluation",
      },
      connectedAppIds: [],
      secretScanStatus: "passed",
      piiScanStatus: "passed",
      licensingStatus: "approved",
      metadata: {
        workflowSignature: "cross-system-operations",
        verifiableOutcome: true,
        syntheticSpecification: true,
        containsCustomerData: false,
        crossSystemOperations: {
          schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
          generatorVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
          taskId: task.id,
          worldId: task.worldId,
          taskFamily: task.family,
          taskPrompt: task.prompt,
          expectedAnswer: task.expectedAnswer,
          toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
          approved: false,
          worldSeed: world.seed,
          worldSplit: task.split,
          worldDifficulty: task.difficulty,
        },
      },
    });
  });
  const sourceByTaskId = new Map(
    selectedTasks.map((task, index) => [task.id, sources[index]!]),
  );
  const tasks = selectedTasks.map((task): TaskDataRecord => {
    const source = sourceByTaskId.get(task.id)!;
    return {
      schemaVersion: "openpond.taskData.v1",
      id: `task_${contentHash([taskset.id, task.id]).slice(0, 20)}`,
      clusterKey: task.worldId,
      split: task.split,
      input: { prompt: task.prompt },
      expectedOutput: {
        text: `ANSWER: ${JSON.stringify(task.expectedAnswer)}`,
      },
      policyVisibleContext: {},
      privilegedContextRef: `ground_truth_${task.id}`,
      sourceRefs: [source.id],
      tags: [
        "synthetic",
        "crm-billing-support",
        `phrasing-${task.phrasingVariant}`,
      ],
      metadata: {
        approvalStatus: "unapproved",
        exampleOrigin: "synthetic",
        exampleRationale:
          "Deterministic versioned CRM, billing, and support scenario; no customer conversation was used.",
        flagship: "cross-system-operations",
        taskId: task.id,
        worldId: task.worldId,
        toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
        phrasingVariant: task.phrasingVariant,
      },
    };
  });
  const frozenTask = tasks.find((task) => task.split === "frozen_eval");
  if (!frozenTask?.expectedOutput) {
    throw new Error("The synthetic suite did not generate a frozen evaluation task.");
  }
  const graderFixtures = taskset.graderFixtures.map((fixture) => ({
    ...fixture,
    taskId: frozenTask.id,
    output:
      fixture.metadata.substituteExpectedOutput === true
        ? {
            ...frozenTask.expectedOutput,
            ...Object.fromEntries(
              Object.entries(fixture.output).filter(
                ([key, value]) =>
                  key !== "text" && value !== "__EXPECTED_OUTPUT__",
              ),
            ),
          }
        : fixture.output,
  }));
  const {
    expertBootstrap: _priorExpertBootstrap,
    worldSpecs: _priorWorldSpecs,
    sourceTrajectoryCount: _priorSourceTrajectoryCount,
    ...priorMetadata
  } = taskset.metadata;
  const draft = TasksetSchema.parse({
    ...taskset,
    revision: taskset.revision + 1,
    name: args.suite === "renewal-risk-v2" ? "Renewal Risk Triage" : taskset.name,
    status: "needs_review",
    sourceRefs: sources,
    environment: {
      ...taskset.environment,
      metadata: {
        ...taskset.environment.metadata,
        generatorVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
        sourceTrajectoryCount: selectedTasks.length,
        baselineRewardVariance: 0,
        worldSpecs,
      },
    },
    capabilities: {
      ...taskset.capabilities,
      supportedSignals: ["demonstration", "reward"],
      compatibleMethods: ["sft", "grpo"],
    },
    tasks,
    graderFixtures,
    learningSignals: {
      demonstrations: [],
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [],
      labels: [],
    },
    authoringProvenance: {
      ...taskset.authoringProvenance,
      model: null,
      modelConfig: {
        source: "deterministic_cross_system_suite",
      },
      evidenceHashes: sources.map((source) => source.sourceHash),
      createdAt: timestamp,
    },
    readiness: null,
    contentHash: "00000000",
    updatedAt: timestamp,
    metadata: {
      ...priorMetadata,
      generatorVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
      sourceTrajectoryCount: selectedTasks.length,
      baselineRewardVariance: 0,
      worldSpecs,
      trainingPath: {
        primaryMethod: "grpo",
        bootstrap: null,
      },
      warnings: [
        ...new Set([
          ...stringArray(taskset.metadata.warnings).filter(
            (warning) =>
              !warning.toLowerCase().includes("no approved correct trajectory")
              && !warning.toLowerCase().includes("frontier authoring model"),
          ),
          "The Taskset is entirely synthetic and contains no customer conversations.",
          "Expert trajectories require signed-in review before SFT export.",
        ]),
      ],
      syntheticSuite: {
        schemaVersion: "openpond.crossSystemSyntheticSuite.v1",
        suite: args.suite,
        scenarioProfile:
          args.suite === "renewal-risk-v2" ? "renewal_risk_v2" : null,
        taskFamilies: selectedFamilies,
        taskCount: selectedTasks.length,
        trainCount: tasks.filter((task) => task.split === "train").length,
        validationCount: tasks.filter((task) => task.split === "validation").length,
        frozenEvaluationCount:
          tasks.filter((task) => task.split === "frozen_eval").length,
        containsCustomerData: false,
        generatedAt: timestamp,
      },
    },
  });
  const revised = TasksetSchema.parse({
    ...draft,
    contentHash: computeTasksetHash(draft),
  });
  const generatedFiles = crossSystemGeneratedTaskFiles({
    worlds,
    tasks: generatedTasks,
  });
  const creationSnapshotId =
    typeof taskset.metadata.creationSnapshotId === "string"
      ? taskset.metadata.creationSnapshotId
      : null;
  const snapshot = creationSnapshotId
    ? await store.getTaskCreationSnapshot(creationSnapshotId)
    : null;
  const proposal = snapshot?.proposal
      ? TaskDesignProposalSchema.parse({
        ...snapshot.proposal,
        name:
          args.suite === "renewal-risk-v2"
            ? "Renewal Risk Triage"
            : snapshot.proposal.name,
        objective:
          args.suite === "renewal-risk-v2"
            ? "Identify near-term renewals with material overdue balances and unresolved P1 support risk."
            : snapshot.proposal.objective,
        sourceIds: sources.map((source) => source.id),
        proposedExamples: tasks.map((task) => {
          const source = sources.find((item) => item.id === task.sourceRefs[0])!;
          return {
            id: `example_${contentHash([snapshot.proposal!.id, task.id]).slice(0, 20)}`,
            sourceId: source.id,
            sourceTurnId: null,
            split: task.split,
            origin: "synthetic",
            inputPrompt: String(task.input.prompt),
            expectedOutputText: null,
            rationale:
              "Deterministic synthetic CRM, billing, and support scenario with privileged exact ground truth.",
          };
        }),
        generatedFiles,
        trainingPath: {
          primaryMethod: "grpo",
          bootstrap: null,
        },
        warnings: [
          ...new Set([
            ...stringArray(snapshot.proposal.warnings).filter(
              (warning) =>
                !warning.toLowerCase().includes("no approved correct trajectory"),
            ),
            "The Taskset is entirely synthetic and contains no customer conversations.",
          ]),
        ],
      })
    : null;

  const summary = {
    tasksetId: revised.id,
    priorRevision: taskset.revision,
    revision: revised.revision,
    contentHash: revised.contentHash,
    sourceCount: sources.length,
    taskCount: tasks.length,
    trainCount: tasks.filter((task) => task.split === "train").length,
    validationCount: tasks.filter((task) => task.split === "validation").length,
    frozenEvaluationCount:
      tasks.filter((task) => task.split === "frozen_eval").length,
    phrasingVariants: [...new Set(
      tasks.map((task) => Number(task.metadata.phrasingVariant)),
    )].sort(),
    suite: args.suite,
    scenarioProfile:
      args.suite === "renewal-risk-v2" ? "renewal_risk_v2" : null,
    taskFamilies: selectedFamilies,
    containsCustomerData: false,
    apply: args.apply,
  };
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    for (const source of sources) await store.upsertTrainingSource(source);
    await buildTaskset(
      revised,
      path.join(args.storeDir, "training", "tasksets", revised.id),
      { generatedFiles },
    );
    await store.upsertTaskset(revised);
    if (snapshot && proposal) {
      await store.upsertTaskCreationSnapshot({
        ...snapshot,
        request: {
          ...snapshot.request,
          sourceIds: sources.map((source) => source.id),
        },
        proposal,
        updatedAt: timestamp,
      });
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
} finally {
  await store.close();
}

function parseArguments(values: string[]): Arguments {
  let apply = false;
  let storeDir = process.env.OPENPOND_APP_HOME
    ?? path.join(process.env.HOME ?? "", ".openpond", "openpond-app");
  let suite: Arguments["suite"] = "balanced";
  let tasksetId = "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--apply") {
      apply = true;
    } else if (value === "--store-dir") {
      storeDir = requiredArgument(values[++index], "--store-dir");
    } else if (value === "--taskset-id") {
      tasksetId = requiredArgument(values[++index], "--taskset-id");
    } else if (value === "--suite") {
      const requested = requiredArgument(values[++index], "--suite");
      if (requested !== "balanced" && requested !== "renewal-risk-v2") {
        throw new Error("--suite must be balanced or renewal-risk-v2.");
      }
      suite = requested;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!tasksetId) throw new Error("--taskset-id is required.");
  return { apply, storeDir: path.resolve(storeDir), suite, tasksetId };
}

function requiredArgument(
  value: string | undefined,
  name: string,
): string {
  if (!value?.trim()) throw new Error(`${name} requires a value.`);
  return value;
}

function familyLabel(family: CrossSystemTaskFamily): string {
  return family.replaceAll("_", " ");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && Boolean(item.trim()),
      )
    : [];
}

function selectedWorldSpecs(
  suite: Arguments["suite"],
): CrossSystemWorldSpec[] {
  if (suite === "balanced") {
    return DEFAULT_CROSS_SYSTEM_WORLD_SPECS.map((spec) => ({ ...spec }));
  }
  return [
    ...worldSpecsForSplit("train", 601, 50),
    ...worldSpecsForSplit("validation", 701, 10),
    ...worldSpecsForSplit("frozen_eval", 801, 10),
  ];
}

function worldSpecsForSplit(
  split: CrossSystemWorldSpec["split"],
  firstSeed: number,
  count: number,
): CrossSystemWorldSpec[] {
  const difficulties = ["easy", "medium", "hard"] as const;
  return Array.from({ length: count }, (_, index) =>
    CrossSystemWorldSpecSchema.parse({
      seed: firstSeed + index,
      split,
      difficulty: difficulties[index % difficulties.length],
      scenarioProfile: "renewal_risk_v2",
    }));
}
