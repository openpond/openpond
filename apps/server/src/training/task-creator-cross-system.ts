import {
  CROSS_SYSTEM_LOCAL_TOOL_SYSTEM_PROMPT,
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_NAMES,
  CrossSystemBootstrapMessageSchema,
  conciseWorkproductName,
  TaskDesignProposalSchema,
  type TaskDesignProposal,
  type TrainingSourceRef,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  crossSystemGeneratedTaskFiles,
  generateCrossSystemTasks,
  generateCrossSystemWorld,
  type CrossSystemDifficulty,
  type CrossSystemSplit,
} from "./cross-system-operations/index.js";
import { defaultFixtureTemplates } from "./task-creator-fixtures.js";

export function crossSystemStructuredExample(source: TrainingSourceRef): {
  prompt: string;
  finalAnswer: string;
  inputMessages: Array<{
    role: string;
    content: string | null;
    tool_call_id?: string;
    tool_calls?: unknown[];
  }>;
  outputMessages: Array<{
    role: string;
    content: string | null;
    tool_call_id?: string;
    tool_calls?: unknown[];
  }>;
} | null {
  const metadata = metadataRecord(source.metadata.crossSystemOperations);
  if (!metadata || metadata.approved !== true || metadata.outcome !== "correct") return null;
  const parsed = Array.isArray(metadata.bootstrapMessages)
    ? metadata.bootstrapMessages.flatMap((message) => {
      const result = CrossSystemBootstrapMessageSchema.safeParse(message);
      return result.success ? [result.data] : [];
    })
    : [];
  if (parsed.length < 3) return null;
  const firstAssistantIndex = parsed.findIndex((message) => message.role === "assistant");
  if (firstAssistantIndex < 2) return null;
  const sourceInputMessages = parsed.slice(0, firstAssistantIndex);
  const inputMessages = [
    { role: "system" as const, content: CROSS_SYSTEM_LOCAL_TOOL_SYSTEM_PROMPT },
    ...sourceInputMessages.filter((message) => message.role !== "system"),
  ];
  const outputMessages = parsed.slice(firstAssistantIndex);
  const prompt = [...inputMessages].reverse()
    .find((message) => message.role === "user")?.content;
  const finalAnswer = [...outputMessages].reverse()
    .find((message) => message.role === "assistant" && typeof message.content === "string")?.content;
  return typeof prompt === "string" && typeof finalAnswer === "string"
    ? { prompt, finalAnswer, inputMessages, outputMessages }
    : null;
}

export function enrichCrossSystemProposal(
  proposal: TaskDesignProposal,
  sources: TrainingSourceRef[],
): TaskDesignProposal {
  const lineage = crossSystemLineage(sources);
  if (!lineage) return proposal;
  const worldByKey = new Map<string, ReturnType<typeof generateCrossSystemWorld>>();
  for (const trace of lineage.traces) {
    const key = `${trace.worldSplit}:${trace.worldSeed}:${trace.worldDifficulty}`;
    if (!worldByKey.has(key)) {
      worldByKey.set(key, generateCrossSystemWorld({
        seed: trace.worldSeed,
        split: trace.worldSplit,
        difficulty: trace.worldDifficulty,
      }));
    }
  }
  const worlds = [...worldByKey.values()];
  const tasks = worlds.flatMap(generateCrossSystemTasks);
  const traceBySource = new Map(lineage.traces.map((trace) => [trace.sourceId, trace]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const approvedSuccessfulSources = new Set(sources.flatMap((source) => {
    const record = metadataRecord(source.metadata.crossSystemOperations);
    return record?.approved === true && record.outcome === "correct" ? [source.id] : [];
  }));
  const existingExampleBySource = new Map(
    proposal.proposedExamples.map((example) => [example.sourceId, example]),
  );
  const proposedExamples = sources.flatMap((source) => {
    const trace = traceBySource.get(source.id);
    const record = metadataRecord(source.metadata.crossSystemOperations);
    const taskId = typeof record?.taskId === "string" ? record.taskId : null;
    const task = taskId ? taskById.get(taskId) ?? null : null;
    const prompt = typeof record?.taskPrompt === "string" ? record.taskPrompt : task?.prompt;
    const expectedAnswer = metadataRecord(record?.expectedAnswer) ?? task?.expectedAnswer ?? null;
    if (!trace || !prompt || !expectedAnswer) return [];
    const existing = existingExampleBySource.get(source.id);
    const approved = approvedSuccessfulSources.has(source.id);
    return [{
      id: existing?.id ?? `example_${contentHash([proposal.id, source.id]).slice(0, 20)}`,
      sourceId: source.id,
      sourceTurnId: existing?.sourceTurnId ?? null,
      split: trace.worldSplit,
      origin: "synthetic" as const,
      inputPrompt: prompt,
      expectedOutputText: approved ? `ANSWER: ${JSON.stringify(expectedAnswer)}` : null,
      rationale: approved
        ? "Approved successful trajectory from the deterministic synthetic Cross-System Operations environment."
        : "Reward-bearing environment task with privileged deterministic ground truth; the failed policy output is not a demonstration.",
    }];
  });
  return TaskDesignProposalSchema.parse({
    ...proposal,
    name: conciseWorkproductName(proposal.name, "Cross-System Operations Reconciliation"),
    diagnosis: {
      ...proposal.diagnosis,
      summary: "Navigate bounded synthetic CRM, billing, and support systems to produce exact cross-system operational answers.",
      stableBehavior: [...new Set([...proposal.diagnosis.stableBehavior, "Choose an efficient bounded multi-system query plan and return the exact typed answer envelope."])],
      changingKnowledge: [...new Set([...proposal.diagnosis.changingKnowledge, "Account, invoice, payment, contract, and support facts remain environment state rather than model weights."])],
      requiredContext: [...new Set([...proposal.diagnosis.requiredContext, "The seeded synthetic world and attempt budget are supplied at runtime."])],
      requiredTools: [...CROSS_SYSTEM_TOOL_NAMES],
      intervention: "grpo_rft",
      trainingEligible: true,
      rationale: [...new Set([...proposal.diagnosis.rationale, `The frozen exact verifier observed ${lineage.rewards.length} eligible attempts with reward variance ${lineage.variance.toFixed(6)} under ${CROSS_SYSTEM_TOOL_CONTRACT_HASH}.`])],
      confidence: Math.max(0.95, proposal.diagnosis.confidence),
    },
    taskKind: "single_agent",
    proposedMethod: "grpo",
    proposedExamples,
    proposedGraders: [{
      id: "cross_system_trajectory",
      version: "1",
      label: "Exact Cross-System Operations trajectory",
      kind: "custom_verifier",
      weight: 1,
      hardGate: true,
      rewardEligible: true,
      privileged: true,
      module: "graders/cross-system-verifier.ts",
      exportName: "verifyCrossSystem",
      timeoutMs: 5_000,
      networkPolicy: "none",
      metadata: {
        toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
        rewardFormula: "1.00 exact + 0.10 efficiency + 0.05 concision",
      },
    }],
    graderFixtures: defaultFixtureTemplates(),
    generatedFiles: crossSystemGeneratedTaskFiles({ worlds, tasks }),
    policy: {
      ...proposal.policy,
      policyVisibleFields: [...new Set([...proposal.policy.policyVisibleFields, "input.prompt"])],
      privilegedFields: [...new Set([...proposal.policy.privilegedFields, "expectedOutput.text"])],
      hiddenGraderRefs: [...new Set([...proposal.policy.hiddenGraderRefs, "cross_system_trajectory"])],
      connectedAppScopes: [],
    },
    warnings: [...new Set([
      ...proposal.warnings.filter((warning) => !supersededCrossSystemWarning(warning)),
      "The primary recommendation is GRPO and requires a later credentialed GPU path; local SFT is only an approved trajectory bootstrap.",
      "Synthetic tools have no production credentials or network access.",
      ...(!approvedSuccessfulSources.size
        ? ["No approved correct trajectory is available for the optional SFT bootstrap; failed policy outputs remain excluded from demonstrations."]
        : []),
    ])],
  });
}

export function crossSystemGroundTruth(source: TrainingSourceRef | undefined): {
  prompt: string;
  expectedAnswer: Record<string, unknown>;
} | null {
  if (!source) return null;
  const record = metadataRecord(source.metadata.crossSystemOperations);
  if (!record || record.toolContractHash !== CROSS_SYSTEM_TOOL_CONTRACT_HASH) return null;
  const directPrompt = typeof record.taskPrompt === "string" ? record.taskPrompt : null;
  const directExpectedAnswer = metadataRecord(record.expectedAnswer);
  if (directPrompt && directExpectedAnswer) {
    return { prompt: directPrompt, expectedAnswer: directExpectedAnswer };
  }
  const worldSeed = typeof record.worldSeed === "number" && Number.isInteger(record.worldSeed)
    ? record.worldSeed
    : null;
  const worldSplit = crossSystemSplit(record.worldSplit);
  const worldDifficulty = crossSystemDifficulty(record.worldDifficulty);
  const taskId = typeof record.taskId === "string" ? record.taskId : null;
  if (worldSeed === null || !worldSplit || !worldDifficulty || !taskId) return null;
  const task = generateCrossSystemTasks(generateCrossSystemWorld({
    seed: worldSeed,
    split: worldSplit,
    difficulty: worldDifficulty,
  })).find((candidate) => candidate.id === taskId);
  return task ? { prompt: task.prompt, expectedAnswer: task.expectedAnswer } : null;
}

export function crossSystemTasksetMetadata(
  sources: TrainingSourceRef[],
): Record<string, unknown> {
  const lineage = crossSystemLineage(sources);
  return lineage ? {
    flagship: "cross-system-operations",
    schemaVersion: "openpond.crossSystemOperations.v1",
    generatorVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
    toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
    sourceTrajectoryCount: lineage.traces.length,
    baselineRewardVariance: lineage.variance,
    worldSpecs: [...new Map(lineage.traces.map((trace) => [
      `${trace.worldSplit}:${trace.worldSeed}:${trace.worldDifficulty}`,
      { seed: trace.worldSeed, split: trace.worldSplit, difficulty: trace.worldDifficulty },
    ])).values()],
  } : {};
}

export function crossSystemExampleMetadata(source: TrainingSourceRef): Record<string, unknown> {
  const record = metadataRecord(source.metadata.crossSystemOperations);
  return record?.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH ? {
    flagship: "cross-system-operations",
    toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
    trajectoryId: record.trajectoryId,
    worldId: record.worldId,
    taskId: record.taskId,
    approvalStatus: record.approved === true ? "approved" : "unapproved",
  } : {};
}

function supersededCrossSystemWarning(warning: string): boolean {
  const normalized = warning.toLowerCase();
  return normalized.includes("explicitly exposes only three tool names")
    || normalized.includes("exact fourth tool schema")
    || normalized.includes("generatedfiles is therefore empty")
    || (normalized.includes("not included as file contents") && /(generator|registry|verifier)/.test(normalized))
    || normalized.includes("must import and hash-check those existing artifacts");
}

function crossSystemLineage(sources: TrainingSourceRef[]): {
  traces: Array<{
    sourceId: string;
    worldSeed: number;
    worldSplit: CrossSystemSplit;
    worldDifficulty: CrossSystemDifficulty;
  }>;
  rewards: number[];
  variance: number;
} | null {
  if (sources.length < 3) return null;
  const traces = sources.flatMap((source) => {
    const record = metadataRecord(source.metadata.crossSystemOperations);
    if (!record || record.toolContractHash !== CROSS_SYSTEM_TOOL_CONTRACT_HASH) return [];
    const worldSeed = typeof record.worldSeed === "number" && Number.isInteger(record.worldSeed)
      ? record.worldSeed
      : null;
    const worldSplit = crossSystemSplit(record.worldSplit);
    const worldDifficulty = crossSystemDifficulty(record.worldDifficulty);
    return worldSeed === null || !worldSplit || !worldDifficulty
      ? []
      : [{ sourceId: source.id, worldSeed, worldSplit, worldDifficulty }];
  });
  if (traces.length !== sources.length) return null;
  const rewards = sources.flatMap((source) => {
    const record = metadataRecord(source.metadata.crossSystemOperations);
    return typeof record?.reward === "number" && Number.isFinite(record.reward)
      ? [record.reward]
      : [];
  });
  if (rewards.length < 3) return null;
  const mean = rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length;
  const variance = rewards.reduce((sum, reward) => sum + (reward - mean) ** 2, 0)
    / rewards.length;
  return { traces, rewards, variance };
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function crossSystemSplit(value: unknown): CrossSystemSplit | null {
  return value === "train" || value === "validation" || value === "frozen_eval"
    ? value
    : null;
}

function crossSystemDifficulty(value: unknown): CrossSystemDifficulty | null {
  return value === "easy" || value === "medium" || value === "hard" ? value : null;
}
