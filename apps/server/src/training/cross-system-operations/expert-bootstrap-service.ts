import path from "node:path";
import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CrossSystemWorldSpecSchema,
  CrossSystemExpertBootstrapApprovalSchema,
  CrossSystemExpertBootstrapPreviewSchema,
  TasksetSchema,
  type CrossSystemBootstrapRecord,
  type CrossSystemExpertBootstrapApproval,
  type CrossSystemExpertBootstrapPreview,
  type GeneratedTaskFile,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";
import {
  buildTaskset,
  computeTasksetHash,
  contentHash,
} from "@openpond/taskset-sdk";
import type { SqliteStore } from "../../store/store.js";
import { buildExpertCrossSystemTrajectories } from "./baseline.js";
import { buildCrossSystemBootstrapDataset } from "./bootstrap-dataset.js";
import {
  generateCrossSystemTasks,
  generateCrossSystemWorld,
} from "./world-generator.js";
import type {
  CrossSystemTask,
  CrossSystemWorld,
} from "./types.js";

const EXPERT_BOOTSTRAP_FIXTURE = "fixtures/expert-bootstrap.json";

export function createCrossSystemExpertBootstrapService(deps: {
  store: SqliteStore;
  storeDir: string;
  resolveApprovalActor?: () => Promise<string | null>;
  now?: () => string;
}) {
  const now = deps.now ?? (() => new Date().toISOString());

  async function preview(tasksetId: string): Promise<CrossSystemExpertBootstrapPreview> {
    const taskset = await requireTaskset(tasksetId);
    const prepared = await prepare(taskset);
    return prepared.preview;
  }

  async function approve(input: {
    tasksetId: string;
    previewHash: string;
  }): Promise<{ approval: CrossSystemExpertBootstrapApproval; taskset: Taskset }> {
    const actor = await requireApprovalActor();
    const taskset = await requireTaskset(input.tasksetId);
    const existingApproval = existingExpertApproval(taskset);
    if (existingApproval) {
      if (existingApproval.approvedBy !== actor) {
        throw new Error(
          `Expert trajectories were approved by ${existingApproval.approvedBy}; the signed-in OpenPond account is ${actor}.`,
        );
      }
    }

    const prepared = await prepare(taskset);
    if (
      existingApproval
      && approvedTrajectoryHashes(taskset).join(":")
        === prepared.preview.tasks.map((item) => item.trajectoryHash).join(":")
    ) {
      return { approval: existingApproval, taskset };
    }
    if (input.previewHash !== prepared.preview.previewHash) {
      throw new Error("The expert trajectory preview is stale. Review the current trajectories before approval.");
    }
    const approvedAt = now();
    const records = buildCrossSystemBootstrapDataset({
      tasks: prepared.environmentTasks,
      trajectories: prepared.trajectories,
      results: prepared.results,
      approvedTrajectoryIds: prepared.trajectories.map((trajectory) => trajectory.id),
      approvedBy: actor,
      approvedAt,
    });
    if (records.length !== prepared.taskLinks.length) {
      throw new Error("Every reviewed train task must produce one exact, reward-eligible expert trajectory.");
    }
    const recordByEnvironmentTaskId = new Map(records.map((record) => [record.taskId, record]));
    const approval = CrossSystemExpertBootstrapApprovalSchema.parse({
      status: "approved",
      approvedBy: actor,
      approvedAt,
      previewHash: prepared.preview.previewHash,
      trajectoryCount: records.length,
    });
    const tasks = taskset.tasks.map((task) => {
      const link = prepared.taskLinks.find((candidate) => candidate.tasksetTask.id === task.id);
      if (!link) return task;
      const record = recordByEnvironmentTaskId.get(link.environmentTask.id);
      if (!record) throw new Error(`Approved trajectory for ${link.environmentTask.id} is missing.`);
      return approvedTask(task, record, approval);
    });
    const demonstrations = [
      ...taskset.learningSignals.demonstrations.filter(
        (signal) => !prepared.taskLinks.some((link) => link.tasksetTask.id === signal.taskId),
      ),
      ...prepared.taskLinks.map(({ tasksetTask, environmentTask }) => {
        const record = recordByEnvironmentTaskId.get(environmentTask.id)!;
        return {
          id: `demo_${tasksetTask.id}`,
          kind: "demonstration" as const,
          taskId: tasksetTask.id,
          sourceRefs: tasksetTask.sourceRefs,
          artifactRef: record.id,
          approved: true,
          confidence: 1,
          metadata: {
            exampleOrigin: "expert_authored",
            approvedBy: actor,
            approvedAt,
            approval: "explicit_expert_trajectory_review",
            previewHash: approval.previewHash,
            trajectoryId: record.trajectoryId,
            toolContractHash: record.toolContractHash,
          },
        };
      }),
    ];
    const demonstrationRefs = prepared.taskLinks.map(
      ({ tasksetTask }) => `demo_${tasksetTask.id}`,
    );
    const timestamp = approvedAt;
    const draft = TasksetSchema.parse({
      ...taskset,
      revision: taskset.revision + 1,
      status: "needs_review",
      tasks,
      learningSignals: {
        ...taskset.learningSignals,
        demonstrations,
      },
      readiness: null,
      contentHash: "00000000",
      updatedAt: timestamp,
      metadata: {
        ...taskset.metadata,
        trainingPath: {
          primaryMethod: "grpo",
          bootstrap: {
            method: "sft",
            purpose: "trajectory_bootstrap",
            demonstrationRefs,
            limitations: [
              "The SFT bootstrap imitates approved trajectories; it does not optimize verifier reward.",
              "Completing the bootstrap does not satisfy the primary GRPO recommendation.",
            ],
          },
        },
        warnings: stringArray(taskset.metadata.warnings).filter(
          (warning) =>
            !warning.toLowerCase().includes("no approved correct trajectory")
            && !warning.toLowerCase().includes("require signed-in review"),
        ),
        expertBootstrap: {
          schemaVersion: "openpond.crossSystemExpertBootstrap.v1",
          parentTasksetHash: taskset.contentHash,
          previewHash: approval.previewHash,
          fixturePath: EXPERT_BOOTSTRAP_FIXTURE,
          approval,
          recordIds: records.map((record) => record.id),
          trajectoryHashes: prepared.preview.tasks.map((item) => item.trajectoryHash),
        },
      },
    });
    const updated = TasksetSchema.parse({
      ...draft,
      contentHash: computeTasksetHash(draft),
    });
    const generatedFiles = await generatedTaskFiles(taskset, records, approval);
    await buildTaskset(
      updated,
      path.join(deps.storeDir, "training", "tasksets", updated.id),
      { generatedFiles },
    );
    await deps.store.upsertTaskset(updated);
    return { approval, taskset: updated };
  }

  async function prepare(taskset: Taskset) {
    assertCrossSystemTaskset(taskset);
    const { worlds, tasks: generatedTasks } = generatedSuite(taskset);
    const taskLinks = taskset.tasks
      .filter((task) => task.split === "train")
      .map((tasksetTask) => {
        const environmentTaskId = requiredString(
          tasksetTask.metadata.taskId,
          `Task ${tasksetTask.id} environment task ID`,
        );
        const environmentTask = generatedTasks.find((task) => task.id === environmentTaskId);
        if (!environmentTask) throw new Error(`Cross-System task ${environmentTaskId} could not be regenerated.`);
        assertTaskLineage(tasksetTask, environmentTask);
        return { tasksetTask, environmentTask };
      });
    if (!taskLinks.length) throw new Error("The Cross-System Taskset has no train-split tasks.");
    const environmentTasks = taskLinks.map((link) => link.environmentTask);
    const { trajectories, results } = await buildExpertCrossSystemTrajectories({
      worlds,
      tasks: environmentTasks,
    });
    if (trajectories.length !== taskLinks.length || results.length !== taskLinks.length) {
      throw new Error("Expert trajectory generation did not cover every train task.");
    }
    const previewRecords = buildCrossSystemBootstrapDataset({
      tasks: environmentTasks,
      trajectories,
      results,
      approvedTrajectoryIds: trajectories.map((trajectory) => trajectory.id),
      approvedBy: "preview",
      approvedAt: taskset.updatedAt,
    });
    const recordByTaskId = new Map(previewRecords.map((record) => [record.taskId, record]));
    const resultByTrajectoryId = new Map(results.map((result) => [result.trajectoryId, result]));
    const trajectoryByTaskId = new Map(trajectories.map((trajectory) => [trajectory.taskId, trajectory]));
    const previewTasks = taskLinks.map(({ tasksetTask, environmentTask }) => {
      const trajectory = trajectoryByTaskId.get(environmentTask.id);
      const record = recordByTaskId.get(environmentTask.id);
      const result = trajectory ? resultByTrajectoryId.get(trajectory.id) : null;
      if (!trajectory || !record || result?.reward === null || result?.reward === undefined) {
        throw new Error(`Expert preview for ${environmentTask.id} is incomplete.`);
      }
      const final = [...trajectory.steps].reverse().find((step) => step.kind === "final");
      if (!final || final.kind !== "final") throw new Error(`Expert trajectory ${trajectory.id} has no final answer.`);
      const toolNames = trajectory.steps.flatMap((step) => step.kind === "tool_call" ? [step.name] : []);
      return {
        tasksetTaskId: tasksetTask.id,
        environmentTaskId: environmentTask.id,
        family: environmentTask.family,
        prompt: environmentTask.prompt,
        finalAnswer: final.content,
        trajectoryId: trajectory.id,
        trajectoryHash: contentHash({
          trajectory,
          trainingMessages: record.messages,
        }),
        toolNames,
        toolCallCount: toolNames.length,
        messageCount: record.messages.length,
        reward: result.reward,
        messages: record.messages,
      };
    });
    const previewHash = contentHash({
      schemaVersion: "openpond.crossSystemExpertBootstrapPreview.v1",
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      tasksetRevision: taskset.revision,
      toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      trajectories: previewTasks.map((item) => ({
        tasksetTaskId: item.tasksetTaskId,
        environmentTaskId: item.environmentTaskId,
        trajectoryHash: item.trajectoryHash,
      })),
    });
    const existingApproval = existingExpertApproval(taskset);
    const currentTrajectoryHashes = previewTasks.map(
      (item) => item.trajectoryHash,
    );
    const approval = existingApproval
      && approvedTrajectoryHashes(taskset).join(":")
        === currentTrajectoryHashes.join(":")
      ? existingApproval
      : null;
    const preview = CrossSystemExpertBootstrapPreviewSchema.parse({
      schemaVersion: "openpond.crossSystemExpertBootstrapPreview.v1",
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      tasksetRevision: taskset.revision,
      previewHash,
      toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      status: approval ? "approved" : "ready_for_review",
      approval,
      tasks: previewTasks,
    });
    return { preview, worlds, environmentTasks, taskLinks, trajectories, results };
  }

  async function generatedTaskFiles(
    taskset: Taskset,
    records: CrossSystemBootstrapRecord[],
    approval: CrossSystemExpertBootstrapApproval,
  ): Promise<GeneratedTaskFile[]> {
    const creationSnapshotId = typeof taskset.metadata.creationSnapshotId === "string"
      ? taskset.metadata.creationSnapshotId
      : null;
    const proposal = creationSnapshotId
      ? await deps.store.getTaskDesignProposal(creationSnapshotId)
      : null;
    const fixture: GeneratedTaskFile = {
      path: EXPERT_BOOTSTRAP_FIXTURE,
      role: "fixture",
      content: `${JSON.stringify({
        schemaVersion: "openpond.crossSystemExpertBootstrapFixture.v1",
        tasksetId: taskset.id,
        parentTasksetHash: taskset.contentHash,
        toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
        approval,
        records,
      }, null, 2)}\n`,
    };
    return [
      ...(proposal?.generatedFiles ?? []).filter((file) => file.path !== EXPERT_BOOTSTRAP_FIXTURE),
      fixture,
    ];
  }

  async function requireTaskset(tasksetId: string): Promise<Taskset> {
    const taskset = await deps.store.getTaskset(tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    return taskset;
  }

  async function requireApprovalActor(): Promise<string> {
    const actor = (await deps.resolveApprovalActor?.())?.trim() ?? "";
    if (!actor) {
      throw new Error("Expert trajectory approval requires a signed-in OpenPond account profile with a handle.");
    }
    return actor;
  }

  return { preview, approve };
}

function approvedTask(
  task: TaskDataRecord,
  record: CrossSystemBootstrapRecord,
  approval: CrossSystemExpertBootstrapApproval,
): TaskDataRecord {
  const inputMessages = record.messages.slice(0, 2);
  const outputMessages = record.messages.slice(2);
  if (inputMessages[0]?.role !== "system" || inputMessages[1]?.role !== "user") {
    throw new Error(`Expert trajectory ${record.trajectoryId} has an invalid prompt prefix.`);
  }
  if (outputMessages.at(-1)?.role !== "assistant") {
    throw new Error(`Expert trajectory ${record.trajectoryId} must end with an assistant target.`);
  }
  return {
    ...task,
    input: { ...task.input, messages: inputMessages },
    expectedOutput: { ...(task.expectedOutput ?? {}), messages: outputMessages },
    tags: [...new Set([...task.tags, "structured-tool-trajectory"])],
    metadata: {
      ...task.metadata,
      approvalStatus: "approved",
      exampleOrigin: "expert_authored",
      exampleRationale: "Exact deterministic environment trajectory explicitly reviewed and approved for SFT bootstrap.",
      expertBootstrapRecordId: record.id,
      expertTrajectoryId: record.trajectoryId,
      expertApproval: approval,
    },
  };
}

function approvedTrajectoryHashes(taskset: Taskset): string[] {
  const expertBootstrap = taskset.metadata.expertBootstrap;
  if (!expertBootstrap || typeof expertBootstrap !== "object" || Array.isArray(expertBootstrap)) {
    return [];
  }
  return stringArray(
    (expertBootstrap as Record<string, unknown>).trajectoryHashes,
  );
}

function generatedSuite(taskset: Taskset): {
  worlds: CrossSystemWorld[];
  tasks: CrossSystemTask[];
} {
  const specs = Array.isArray(taskset.metadata.worldSpecs)
    ? taskset.metadata.worldSpecs
    : [];
  const worlds = specs.map((value, index) => {
    const parsed = CrossSystemWorldSpecSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Cross-System world specification ${index + 1} is invalid.`);
    }
    return generateCrossSystemWorld(parsed.data);
  });
  if (!worlds.length) throw new Error("Cross-System world specifications are missing.");
  return { worlds, tasks: worlds.flatMap(generateCrossSystemTasks) };
}

function assertCrossSystemTaskset(taskset: Taskset): void {
  if (taskset.metadata.flagship !== "cross-system-operations") {
    throw new Error("Expert trajectory bootstrap is available only for the Cross-System Operations Taskset.");
  }
  if (taskset.metadata.toolContractHash !== CROSS_SYSTEM_TOOL_CONTRACT_HASH) {
    throw new Error("Cross-System tool contract lineage does not match the current executable environment.");
  }
}

function assertTaskLineage(tasksetTask: TaskDataRecord, environmentTask: CrossSystemTask): void {
  if (tasksetTask.metadata.worldId !== environmentTask.worldId) {
    throw new Error(`Task ${tasksetTask.id} world lineage does not match ${environmentTask.id}.`);
  }
  if (tasksetTask.input.prompt !== environmentTask.prompt) {
    throw new Error(`Task ${tasksetTask.id} prompt does not match the deterministic environment.`);
  }
  const expected = `ANSWER: ${JSON.stringify(environmentTask.expectedAnswer)}`;
  if (tasksetTask.expectedOutput?.text !== expected) {
    throw new Error(`Task ${tasksetTask.id} expected answer does not match the deterministic environment.`);
  }
}

function existingExpertApproval(taskset: Taskset): CrossSystemExpertBootstrapApproval | null {
  const expertBootstrap = record(taskset.metadata.expertBootstrap);
  const parsed = CrossSystemExpertBootstrapApprovalSchema.safeParse(expertBootstrap.approval);
  return parsed.success ? parsed.data : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
