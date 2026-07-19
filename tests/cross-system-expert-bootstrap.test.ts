import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  TasksetSchema,
  type TaskDataRecord,
} from "@openpond/contracts";
import { computeTasksetHash } from "../packages/taskset-sdk/src";
import {
  createCrossSystemExpertBootstrapService,
  generateCrossSystemTasks,
  generateCrossSystemWorld,
} from "../apps/server/src/training/cross-system-operations";
import { renderFireworksSftDataset } from "../apps/server/src/training/fireworks-dataset";
import { tasksetFixture, withTrainingStore } from "./helpers/training-fixtures";

const APPROVED_AT = "2026-07-17T18:00:00.000Z";

describe("Cross-System expert bootstrap", () => {
  test("previews deterministic exact trajectories and materializes only an explicit signed-in approval", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = crossSystemTaskset();
      await store.upsertTaskset(taskset);
      const service = createCrossSystemExpertBootstrapService({
        store,
        storeDir: directory,
        resolveApprovalActor: async () => "0xglu",
        now: () => APPROVED_AT,
      });

      const first = await service.preview(taskset.id);
      const repeated = await service.preview(taskset.id);

      expect(repeated).toEqual(first);
      expect(first).toMatchObject({
        tasksetHash: taskset.contentHash,
        tasksetRevision: 1,
        status: "ready_for_review",
        approval: null,
      });
      expect(first.tasks).toHaveLength(5);
      expect(first.tasks.every((item) =>
        item.reward > 1
        && item.messages[0]?.role === "system"
        && item.messages[1]?.role === "user"
        && item.messages.at(-1)?.role === "assistant"
        && item.messages.some((message) => message.role === "tool"),
      )).toBe(true);
      const renewalToolCalls = first.tasks
        .find((item) => item.family === "renewal_exposure")
        ?.messages.flatMap((message) => message.tool_calls ?? []) ?? [];
      const argumentsByTool = new Map(
        renewalToolCalls.map((call) => [
          call.function.name,
          JSON.parse(call.function.arguments) as Record<string, unknown>,
        ]),
      );
      expect(argumentsByTool.get("search_crm")).toMatchObject({
        query: "*",
        fields: ["account_id", "renewal_date"],
      });
      expect(argumentsByTool.get("query_billing")).toMatchObject({
        status: ["overdue"],
      });
      expect(argumentsByTool.get("search_support")).toMatchObject({
        severity: ["P1"],
        state: ["new", "investigating", "waiting_customer"],
      });
      expect(argumentsByTool.get("run_python")?.code).toEqual(
        expect.stringContaining("overdue_by_account"),
      );
      expect(
        (argumentsByTool.get("query_billing")?.account_ids as string[]).length,
      ).toBe(worldAccountCount(taskset));

      await expect(service.approve({
        tasksetId: taskset.id,
        previewHash: "stale-preview",
      })).rejects.toThrow("preview is stale");

      const approved = await service.approve({
        tasksetId: taskset.id,
        previewHash: first.previewHash,
      });

      expect(approved.approval).toMatchObject({
        approvedBy: "0xglu",
        approvedAt: APPROVED_AT,
        trajectoryCount: 5,
      });
      expect(approved.taskset.revision).toBe(2);
      expect(approved.taskset.contentHash).not.toBe(taskset.contentHash);
      expect(approved.taskset.readiness).toBeNull();
      expect(approved.taskset.learningSignals.demonstrations).toHaveLength(5);
      expect(approved.taskset.learningSignals.demonstrations.every((signal) =>
        signal.approved
        && signal.metadata.exampleOrigin === "expert_authored"
        && signal.metadata.approvedBy === "0xglu",
      )).toBe(true);
      expect(approved.taskset.tasks.filter((item) => item.split === "train").every((item) =>
        item.tags.includes("structured-tool-trajectory")
        && item.metadata.exampleOrigin === "expert_authored"
        && Array.isArray(item.input.messages)
        && Array.isArray(item.expectedOutput?.messages),
      )).toBe(true);

      const fixture = JSON.parse(await readFile(
        path.join(
          directory,
          "training",
          "tasksets",
          taskset.id,
          "fixtures",
          "expert-bootstrap.json",
        ),
        "utf8",
      )) as { approval: { approvedBy: string }; records: unknown[] };
      expect(fixture.approval.approvedBy).toBe("0xglu");
      expect(fixture.records).toHaveLength(5);

      const rendered = renderFireworksSftDataset(approved.taskset);
      expect(rendered.exampleCount).toBe(5);
      expect(rendered.bytes.toString("utf8")).toContain('"tool_calls"');
      expect(rendered.bytes.toString("utf8")).not.toContain("Say goodbye");
      const renderedRecords = rendered.bytes.toString("utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as {
          messages: Array<{ content?: unknown }>;
          tools?: unknown[];
        });
      expect(renderedRecords.every((record) =>
        record.messages.every((message) => typeof message.content === "string"),
      )).toBe(true);
      expect(renderedRecords.every((record) => record.tools?.length === 4)).toBe(true);

      const repeatedApproval = await service.approve({
        tasksetId: taskset.id,
        previewHash: first.previewHash,
      });
      expect(repeatedApproval.taskset.revision).toBe(2);
      expect(repeatedApproval.approval).toEqual(approved.approval);

      const staleDraft = TasksetSchema.parse({
        ...repeatedApproval.taskset,
        revision: repeatedApproval.taskset.revision + 1,
        updatedAt: "2026-07-17T18:05:00.000Z",
        metadata: {
          ...repeatedApproval.taskset.metadata,
          expertBootstrap: {
            ...(repeatedApproval.taskset.metadata.expertBootstrap as Record<string, unknown>),
            trajectoryHashes: ["stale-trajectory-hash"],
          },
        },
        contentHash: "00000000",
      });
      const stale = TasksetSchema.parse({
        ...staleDraft,
        contentHash: computeTasksetHash(staleDraft),
      });
      await store.upsertTaskset(stale);

      const reapprovalPreview = await service.preview(taskset.id);
      expect(reapprovalPreview.status).toBe("ready_for_review");
      expect(reapprovalPreview.approval).toBeNull();
    }));

  test("rejects approval without a signed-in account and prevents another account from replacing it", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = crossSystemTaskset();
      await store.upsertTaskset(taskset);
      const signedOut = createCrossSystemExpertBootstrapService({
        store,
        storeDir: directory,
        resolveApprovalActor: async () => null,
      });
      const preview = await signedOut.preview(taskset.id);
      await expect(signedOut.approve({
        tasksetId: taskset.id,
        previewHash: preview.previewHash,
      })).rejects.toThrow("signed-in OpenPond account");

      const owner = createCrossSystemExpertBootstrapService({
        store,
        storeDir: directory,
        resolveApprovalActor: async () => "0xglu",
        now: () => APPROVED_AT,
      });
      await owner.approve({
        tasksetId: taskset.id,
        previewHash: preview.previewHash,
      });

      const otherAccount = createCrossSystemExpertBootstrapService({
        store,
        storeDir: directory,
        resolveApprovalActor: async () => "someone-else",
      });
      await expect(otherAccount.approve({
        tasksetId: taskset.id,
        previewHash: preview.previewHash,
      })).rejects.toThrow("approved by 0xglu");
    }));
});

function crossSystemTaskset() {
  const base = tasksetFixture();
  const world = generateCrossSystemWorld({
    seed: 301,
    split: "train",
    difficulty: "easy",
  });
  const trainTasks = generateCrossSystemTasks(world)
    .filter((task, _index, tasks) => {
      const familyIndex = [...new Set(tasks.map((item) => item.family))]
        .indexOf(task.family);
      return task.phrasingVariant === familyIndex % 3;
    })
    .map((task): TaskDataRecord => ({
      schemaVersion: "openpond.taskData.v1",
      id: `task_${task.family}`,
      clusterKey: task.clusterKey,
      split: "train",
      input: { prompt: task.prompt },
      expectedOutput: { text: `ANSWER: ${JSON.stringify(task.expectedAnswer)}` },
      policyVisibleContext: {},
      privilegedContextRef: `ground_truth_${task.id}`,
      sourceRefs: [base.sourceRefs[0]!.id],
      tags: ["synthetic"],
      metadata: {
        approvalStatus: "unapproved",
        exampleOrigin: "synthetic",
        flagship: "cross-system-operations",
        taskId: task.id,
        worldId: task.worldId,
        toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      },
    }));
  const draft = TasksetSchema.parse({
    ...base,
    id: "cross-system-expert-bootstrap",
    revision: 1,
    name: "Reconcile CRM billing and support",
    status: "needs_review",
    tasks: [...trainTasks, base.tasks.find((task) => task.split === "frozen_eval")!],
    capabilities: {
      ...base.capabilities,
      supportedSignals: ["demonstration", "reward"],
      compatibleMethods: ["sft", "grpo"],
      requiresTools: true,
      requiresState: true,
    },
    learningSignals: {
      ...base.learningSignals,
      demonstrations: [],
    },
    readiness: null,
    contentHash: "00000000",
    metadata: {
      ...base.metadata,
      flagship: "cross-system-operations",
      toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      trainingMethod: "grpo",
      trainingPath: { primaryMethod: "grpo", bootstrap: null },
      warnings: [
        "No approved correct trajectory is available for the optional SFT bootstrap.",
      ],
      worldSpecs: [{ seed: 301, split: "train", difficulty: "easy" }],
    },
  });
  return TasksetSchema.parse({
    ...draft,
    contentHash: computeTasksetHash(draft),
  });
}

function worldAccountCount(taskset: ReturnType<typeof crossSystemTaskset>) {
  const spec = (taskset.metadata.worldSpecs as Array<{
    seed: number;
    split: "train";
    difficulty: "easy";
  }>)[0]!;
  return generateCrossSystemWorld(spec).accounts.length;
}
