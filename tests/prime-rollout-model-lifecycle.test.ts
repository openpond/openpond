import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PrimeRolloutSmokeReportSchema,
  TasksetSchema,
  type PrimeRolloutSmokeReport,
  type Taskset,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { afterEach, describe, expect, test } from "vitest";

import { SqliteStore } from "../apps/server/src/store/store";
import {
  persistPrimeRolloutSmokeReport,
  preparePrimeRolloutModel,
  reconcilePrimeRolloutSmokeModels,
} from "../apps/server/src/training/prime-rollout-model-lifecycle";
import { tasksetFixture } from "./helpers/training-fixtures";

const roots: string[] = [];
const timestamp = "2026-07-25T06:38:05.678Z";
const completedAt = "2026-07-25T06:48:57.803Z";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Prime rollout Model lifecycle", () => {
  test("persists base version 0 and a successful rollout without inventing an adapter", async () => {
    const { root, store } = await storeFixture();
    const taskset = await saveTaskset(store);
    const report = smokeReport(taskset);
    const reportPath = path.join(
      root,
      "training",
      "prime-rollout-smoke",
      report.runId,
      "smoke-report.json",
    );
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report));

    const prepared = await preparePrimeRolloutModel({
      store,
      taskset,
      runId: report.runId,
      maximumSpendUsd: report.maximumSpendUsd,
      startedAt: report.startedAt,
      resolvedBundleHash: report.upload.resolvedBundleHash,
      harnessRelease: report.assignment.harnessRelease,
      agentRelease: report.assignment.agentRelease,
    });
    expect((await store.getModelVersion(prepared.modelVersionId))?.version).toBe(0);
    expect((await store.getModelRun(report.runId))?.status).toBe("prepared");

    const saved = await persistPrimeRolloutSmokeReport({
      store,
      storeDir: root,
      taskset,
      report,
      reportPath,
    });
    expect(saved.status).toBe("succeeded");
    expect(saved.reward?.raw).toBe(0.829526);
    expect(saved.receipt?.cleanup).toEqual({
      computeReleased: true,
      tunnelClosed: true,
    });
    expect(saved.adapterArtifactLineageId).toBeNull();
    expect((await store.getModelVersion(prepared.modelVersionId))?.adapterStatus)
      .toBe("not_trained");
    expect(await store.listModelArtifactLineage(taskset.id)).toEqual([]);
    await store.close();
  });

  test("backfills a verified smoke report idempotently without a provider run", async () => {
    const { root, store } = await storeFixture();
    const taskset = await saveTaskset(store);
    const report = smokeReport(taskset);
    const reportPath = path.join(
      root,
      "training",
      "prime-rollout-smoke",
      report.runId,
      "smoke-report.json",
    );
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report));

    expect(await reconcilePrimeRolloutSmokeModels({ store, storeDir: root }))
      .toEqual({ imported: [report.runId], skipped: [], errors: [] });
    expect(await reconcilePrimeRolloutSmokeModels({ store, storeDir: root }))
      .toEqual({ imported: [], skipped: [report.runId], errors: [] });
    expect((await store.listModelProjects()).map((project) => project.profileId))
      .toEqual(["default"]);
    await store.close();
  });
});

async function storeFixture(): Promise<{ root: string; store: SqliteStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-model-run-"));
  roots.push(root);
  return { root, store: new SqliteStore(root) };
}

async function saveTaskset(store: SqliteStore): Promise<Taskset> {
  const base = tasksetFixture({ ready: true });
  const taskset = TasksetSchema.parse({
    ...base,
    profileRelease: {
      id: "profile_default",
      revision: 1,
      contentHash: sha256("profile-default"),
    },
  });
  await store.upsertTaskset(taskset);
  return taskset;
}

function smokeReport(taskset: Taskset): PrimeRolloutSmokeReport {
  const runId = "prime_rollout_lifecycle_test";
  const agentRelease = {
    id: "agent_marketing_portfolio_manager",
    contentHash: sha256("agent-release"),
  };
  const harnessRelease = {
    id: "harness_marketing_portfolio",
    contentHash: sha256("harness-release"),
  };
  const assignmentContent = {
    schemaVersion: "openpond.primeRolloutAssignment.v1" as const,
    runId,
    resolvedBundleHash: sha256("resolved-bundle"),
    taskset: {
      id: taskset.id,
      revision: taskset.revision,
      contentHash: taskset.contentHash,
    },
    harnessRelease,
    profileRelease: taskset.profileRelease!,
    agentRelease,
    taskId: taskset.tasks.find((task) => task.split === "train")!.id,
    split: "train" as const,
    policyVersion: "base" as const,
    model: {
      id: "Qwen/Qwen3-0.6B",
      revision: "c1899de289a04d12100db370d81485cdf75e47ca",
    },
    inferencePort: 8_000,
    createdAt: timestamp,
  };
  const assignment = {
    ...assignmentContent,
    assignmentHash: contentHash(assignmentContent),
  };
  const grade = {
    schemaVersion: "openpond.marketingPortfolioGrade.v1" as const,
    benchmarkId: "marketing-portfolio-v1" as const,
    agentReleaseHash: agentRelease.contentHash,
    scorerImplementationHash: sha256("scorer"),
    terminalActionId: "submit-budget-decision" as const,
    decisionAccepted: true,
    caseRef: sha256("case"),
    traceHash: sha256("trace"),
    reward: 0.829526,
    components: {
      constraints: 1,
      portfolioValue: 0.975913,
      riskControls: 0,
      rationale: 0,
    },
  };
  const resultContent = {
    schemaVersion: "openpond.primeRolloutResult.v1" as const,
    runId,
    assignmentHash: assignment.assignmentHash,
    status: "succeeded" as const,
    taskId: assignment.taskId,
    policyVersion: "base" as const,
    model: assignment.model,
    toolSequence: [
      "get_portfolio_snapshot",
      "submit_budget_decision",
    ] as const,
    transcriptHash: sha256("transcript"),
    grade,
    terminal: true,
    failure: null,
    completedAt,
  };
  return PrimeRolloutSmokeReportSchema.parse({
    schemaVersion: "openpond.primeRolloutSmokeReport.v1",
    runId,
    provider: "prime",
    nodeId: "prime_node_test",
    hourlyCostUsd: 3.28288,
    maximumSpendUsd: 13,
    model: assignment.model,
    upload: {
      transport: "scp",
      resolvedBundleHash: assignment.resolvedBundleHash,
      uploaded: true,
    },
    assignment,
    result: {
      ...resultContent,
      resultHash: contentHash(resultContent),
    },
    cleanup: {
      podTerminated: true,
      tunnelClosed: true,
    },
    startedAt: timestamp,
    completedAt,
  });
}
