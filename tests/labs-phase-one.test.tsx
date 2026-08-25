import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  type BaseModelCandidate,
  CrossSystemExpertBootstrapPreviewSchema,
  type ModelEvaluationReceipt,
  type ModelRun,
  type TrainingStateResponse,
} from "@openpond/contracts";
import { createTasksetDraft } from "@openpond/taskset-sdk";
import { LabsView } from "../apps/web/src/components/labs/LabsView";
import { labServingRows } from "../apps/web/src/components/labs/LabServingPage";
import {
  labPrimaryTabFromSearch,
  searchWithLabPrimaryTab,
} from "../apps/web/src/components/labs/lab-primary-tab-state";
import { LabDatasetsPage } from "../apps/web/src/components/labs/LabDatasetsPage";
import { ExpertTrajectoryDialog } from "../apps/web/src/components/labs/LabExpertBootstrap";
import { LabModelDataset } from "../apps/web/src/components/labs/LabModelDataset";
import {
  LabModelCreateDialog,
  labModelCreateCandidates,
} from "../apps/web/src/components/labs/LabModelCreateDialog";
import { ModelsTable } from "../apps/web/src/components/labs/LabsRouteSections";
import { buildLabDetailBreadcrumbs } from "../apps/web/src/hooks/useLabDetailNavigation";
import { labStatusTone } from "../apps/web/src/components/labs/LabStatusBadge";
import {
  BenchmarkAttemptCharts,
  BenchmarkComparisonSummary,
} from "../apps/web/src/components/labs/LabModelEvaluationBenchmarkDetails";
import {
  benchmarkForegroundUsage,
  benchmarkSelectedAttempts,
  benchmarkTaskEfficiency,
} from "../apps/web/src/components/labs/benchmark-attempt-usage";
import {
  labWorkproductProjection,
} from "../apps/web/src/components/labs/lab-workproducts";
import {
  labWorkproductProgression,
} from "../apps/web/src/components/labs/lab-workproduct-progression";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";
import { planFixture, tasksetFixture } from "./helpers/training-fixtures";

const noop = () => undefined;

function modelCandidate(input: {
  available?: boolean;
  label: string;
  modelId: string;
  nonProduction?: boolean;
  selectionKey: string;
  source: BaseModelCandidate["preference"]["source"];
  sourceLabel: string;
}): BaseModelCandidate {
  const available = input.available ?? true;
  const destinationId =
    input.source === "managed"
      ? "openpond_managed"
      : "openpond_managed";
  return {
    schemaVersion: "openpond.baseModelCandidate.v1",
    selectionKey: input.selectionKey,
    label: input.label,
    sourceLabel: input.sourceLabel,
    preference: {
      schemaVersion: "openpond.baseModelPreference.v1",
      modelId: input.modelId,
      revision: null,
      tokenizerRevision: null,
      chatTemplateHash: null,
      modelAssetId: null,
      source: input.source,
    },
    available,
    nonProduction: input.nonProduction ?? false,
    unavailableReason: available ? null : "Provider setup required.",
    methods: ["sft"],
    executionOptions: [
      {
        destinationId,
        available,
        methods: ["sft"],
        parameterizations: ["lora"],
        nonProduction: input.nonProduction ?? false,
        unavailableReason: available ? null : "Provider setup required.",
      },
    ],
  };
}

describe("Lab workspace", () => {
  test("keeps Models subpage navigation out of the page header", () => {
    const markup = renderToStaticMarkup(
      createElement(LabsView, {
        activeTab: "models",
        onCreateDataset: noop,
        onCreateModel: noop,
        children: createElement("div", null, "Unified inventory"),
      }),
    );

    expect(markup).toContain('aria-label="Models"');
    expect(markup).not.toContain('aria-label="Model sections"');
    expect(markup).not.toContain('role="tab"');
    expect(markup).toContain(">New model<");
    expect(markup).not.toContain(">Profile<");
    expect(markup).not.toContain(">Home<");
    expect(markup).not.toContain(">Suggestions<");
    expect(markup).not.toContain("<svg");
    expect(markup).toContain("Unified inventory");
  });

  test("keeps the primary Models tab addressable across refresh and history", () => {
    expect(labPrimaryTabFromSearch("")).toBe("models");
    expect(labPrimaryTabFromSearch("?modelsTab=serving")).toBe("serving");
    expect(labPrimaryTabFromSearch("?modelsTab=usage")).toBe("usage");
    expect(labPrimaryTabFromSearch("?modelsTab=unknown")).toBe("models");
    expect(
      searchWithLabPrimaryTab("?profile=qa", "tasksets"),
    ).toBe("?profile=qa&modelsTab=tasksets");
    expect(
      searchWithLabPrimaryTab("?profile=qa&modelsTab=usage", "models"),
    ).toBe("?profile=qa");
  });

  test("summarizes availability and recent run status on the Models index", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelsTable, {
        items: [
          {
            key: "model:model_fixture",
            kind: "model",
            id: "model_fixture",
            name: "Fixture Model",
            description: "A focused model summary.",
            status: "Ready",
            updatedAt: "2026-07-30T12:00:00.000Z",
            path: null,
            enabled: false,
            runIds: [],
            conversationId: null,
            tasksetId: null,
            trainingRunCount: 0,
            evaluationStatus: "not_run",
            useActionId: null,
            ownerProfileId: "default",
          },
        ],
        loading: false,
        runs: [],
        state: null,
        onSelect: noop,
        onUseModel: noop,
      }),
    );

    expect(markup).toContain(">Availability<");
    expect(markup).toContain(">Recent run<");
    expect(markup).toContain("No active release");
    expect(markup).toContain("Not run");
    expect(markup).toContain("0 runs");
    expect(markup).not.toContain(">Starting model<");
    expect(markup).not.toContain(">Active release<");
  });

  test("names Harness Refiner benchmark results on the Models index", () => {
    const state = {
      modelRuns: [
        {
          id: "model_run_benchmark",
          modelId: "model_fixture",
          kind: "evaluation",
          status: "succeeded",
          updatedAt: "2026-08-09T12:00:00.000Z",
          evaluation: { benchmarkId: "harness-refiner" },
          receipt: {
            schemaVersion: "openpond.modelEvaluationReceipt.v1",
            terminalClassification: "inconclusive",
          },
        },
      ],
      modelVersions: [],
      jobs: [],
      plans: [],
      models: [],
      modelBindings: [],
      tasksets: [],
      modelTasksets: [],
    } as unknown as TrainingStateResponse;
    const markup = renderToStaticMarkup(
      createElement(ModelsTable, {
        items: [
          {
            key: "model:model_fixture",
            kind: "model",
            id: "model_fixture",
            name: "Fixture Model",
            description: "A focused model summary.",
            status: "Succeeded",
            updatedAt: "2026-08-09T12:00:00.000Z",
            path: null,
            enabled: false,
            runIds: [],
            conversationId: null,
            tasksetId: null,
            trainingRunCount: 1,
            evaluationStatus: "not_run",
            useActionId: null,
            ownerProfileId: "default",
          },
        ],
        loading: false,
        runs: [],
        state,
        onSelect: noop,
        onUseModel: noop,
      }),
    );

    expect(markup).toContain("Harness Refiner 08112026 · Inconclusive");
    expect(markup).not.toContain(">1 run<");
  });

  test("leads a completed benchmark with paired task-level token efficiency", () => {
    const attempt = (
      phase: "baseline" | "candidate" | "adaptation" | "candidate_adaptation",
      taskId: string,
      totalTokens: number,
      passed: boolean,
    ) => ({
      attemptId: `${phase}-${taskId}`,
      phase,
      taskId,
      sessionId: null,
      turnId: null,
      passed,
      score: passed ? 1 : 0,
      failureClass: passed ? null : "task_failure",
      inputTokens: totalTokens - 10,
      outputTokens: 10,
      totalTokens,
      latencyMs: 1,
      costUsd: 0.01,
      startedAt: "2026-08-10T21:00:00.000Z",
    });
    const receipt = {
      schemaVersion: "openpond.modelEvaluationReceipt.v1",
      terminalClassification: "regressed",
      quality: { passed: false },
      lineage: { valid: true },
      invalidReasons: ["Candidate held-out quality did not pass every case."],
      foregroundTokenDelta: -1_429_821,
      usage: {
        refiner: { totalTokens: 60_648 },
        grader: { totalTokens: 105_675 },
      },
      efficiency: {
        grossForegroundTokenSavings: 1_429_821,
        firstPassNetTokenSavings: 1_263_498,
        breakEvenReuseCount: 1,
        amortizedReuseCount: 10,
        amortizedTokenSavings: 14_131_887,
      },
      budget: { observedSpendUsd: 0.990634722, maximumSpendUsd: 2 },
      resultManifest: { contentHash: "a".repeat(64) },
      profileGit: null,
      attempts: [
        attempt("adaptation", "adaptation-lower", 200, false),
        attempt("candidate_adaptation", "adaptation-lower", 80, true),
        attempt("baseline", "held-out-higher", 100, true),
        attempt("candidate", "held-out-higher", 120, true),
      ],
    } as unknown as ModelEvaluationReceipt;
    const run = {
      status: "succeeded",
      evaluation: {
        upstreamModel: {
          providerId: "deepseek",
          modelId: "deepseek-v4-pro",
          revision: "catalog-created:1779926400",
        },
      },
    } as unknown as ModelRun;

    const markup = renderToStaticMarkup(
      createElement(BenchmarkComparisonSummary, {
        receipt,
        run,
        tasksetName: "Harness Refiner public v1",
      }),
    );

    expect(markup).toContain("Token efficiency");
    expect(markup).toContain("1 of 2 tasks passed");
    expect(markup).toContain("1 failed this token-efficiency test");
    expect(markup).toContain("aggregate usage changed by -33.33%");
    expect(markup).toContain(">Execution</dt><dd>Succeeded<");
    expect(markup).toContain(">Token-efficiency result</dt><dd>Failed<");
    expect(markup).toContain(">Efficiency passes</dt><dd>1/2<");
    expect(markup).toContain(">Efficiency failures</dt><dd>1/2<");
    expect(markup).toContain(">All-task foreground tokens</dt><dd>300 → 200<");
    expect(markup).toContain(">Task quality</dt><dd>1/2 → 2/2<");
    expect(markup).not.toContain("No accepted Harness improvement");
    expect(markup).not.toContain("Diagnostic gross token savings");
  });

  test("charts selected benchmark attempts without counting discarded recovery work", () => {
    const attempt = (input: {
      attemptId: string;
      phase: "candidate" | "candidate_adaptation";
      taskId: string;
      inputTokens: number;
      outputTokens: number;
      startedAt: string;
    }) => ({
      ...input,
      sessionId: null,
      turnId: null,
      passed: true,
      score: 1,
      failureClass: null,
      totalTokens: input.inputTokens + input.outputTokens,
      latencyMs: 1,
      costUsd: 0.01,
    });
    const receipt = {
      attempts: [
        attempt({
          attemptId: "candidate-discarded",
          phase: "candidate",
          taskId: "held-out-task",
          inputTokens: 47_955,
          outputTokens: 2_574,
          startedAt: "2026-08-10T20:00:00.000Z",
        }),
        attempt({
          attemptId: "candidate-selected",
          phase: "candidate",
          taskId: "held-out-task",
          inputTokens: 999_979,
          outputTokens: 41_114,
          startedAt: "2026-08-10T21:00:00.000Z",
        }),
        attempt({
          attemptId: "adaptation-discarded",
          phase: "candidate_adaptation",
          taskId: "adaptation-task",
          inputTokens: 562_907,
          outputTokens: 7_523,
          startedAt: "2026-08-10T20:00:00.000Z",
        }),
        attempt({
          attemptId: "adaptation-selected",
          phase: "candidate_adaptation",
          taskId: "adaptation-task",
          inputTokens: 2_162_656,
          outputTokens: 79_062,
          startedAt: "2026-08-10T21:00:00.000Z",
        }),
      ],
    } as unknown as ModelEvaluationReceipt;

    const usage = benchmarkForegroundUsage(receipt);

    expect(benchmarkSelectedAttempts(receipt.attempts)).toHaveLength(2);
    expect(usage.candidate).toMatchObject({
      inputTokens: 999_979,
      outputTokens: 41_114,
      totalTokens: 1_041_093,
    });
    expect(usage.candidate_adaptation).toMatchObject({
      inputTokens: 2_162_656,
      outputTokens: 79_062,
      totalTokens: 2_241_718,
    });
  });

  test("pairs benchmark efficiency by task id across both cohorts", () => {
    const attempt = (
      phase: "baseline" | "candidate" | "adaptation" | "candidate_adaptation",
      taskId: string,
      totalTokens: number,
    ) => ({
      attemptId: `${phase}-${taskId}`,
      phase,
      taskId,
      sessionId: null,
      turnId: null,
      passed: true,
      score: 1,
      failureClass: null,
      inputTokens: totalTokens,
      outputTokens: 0,
      totalTokens,
      latencyMs: 1,
      costUsd: 0.01,
      startedAt: "2026-08-10T21:00:00.000Z",
    });
    const receipt = {
      attempts: [
        attempt("baseline", "held-out-b", 100),
        attempt("baseline", "held-out-a", 200),
        attempt("candidate", "held-out-a", 150),
        attempt("candidate", "held-out-b", 120),
        attempt("adaptation", "adaptation-a", 300),
        attempt("candidate_adaptation", "adaptation-a", 100),
      ],
    } as unknown as ModelEvaluationReceipt;

    const efficiency = benchmarkTaskEfficiency(receipt);

    expect(efficiency).toMatchObject({
      comparedTaskCount: 3,
      passedTaskCount: 2,
      failedTaskCount: 1,
      lowerTaskCount: 2,
      higherTaskCount: 1,
      unchangedTaskCount: 0,
      baselineTokens: 600,
      refinedTokens: 370,
      tokenDelta: -230,
      baselinePassedCount: 3,
      refinedPassedCount: 3,
      cohorts: {
        adaptation: { comparedTaskCount: 1, lowerTaskCount: 1 },
        held_out: { comparedTaskCount: 2, lowerTaskCount: 1, higherTaskCount: 1 },
      },
    });
  });

  test("shows token and quality charts for both benchmark cohorts", () => {
    const attempt = (
      phase: "baseline" | "candidate" | "adaptation" | "candidate_adaptation",
      taskId: string,
      totalTokens: number,
      score: number,
    ) => ({
      attemptId: `${phase}-${taskId}`,
      phase,
      taskId,
      sessionId: null,
      turnId: null,
      passed: true,
      score,
      failureClass: null,
      inputTokens: totalTokens - 10,
      outputTokens: 10,
      totalTokens,
      latencyMs: 1,
      costUsd: 0.01,
      startedAt: "2026-08-10T21:00:00.000Z",
    });
    const receipt = {
      attempts: [
        attempt("baseline", "held-out-task", 100, 0.8),
        attempt("candidate", "held-out-task", 60, 1),
        attempt("adaptation", "adaptation-task", 200, 0.6),
        attempt("candidate_adaptation", "adaptation-task", 80, 1),
      ],
    } as unknown as ModelEvaluationReceipt;

    const markup = renderToStaticMarkup(
      createElement(BenchmarkAttemptCharts, { receipt }),
    );

    expect(markup).toContain("Held-out tokens by task");
    expect(markup).toContain("Adaptation tokens by task");
    expect(markup).toContain("Held-out quality by task");
    expect(markup).toContain("Adaptation quality by task");
    expect(markup).toContain("Refined 60");
    expect(markup).toContain("Refined 80");
  });

  test("projects managed publication in Serving", () => {
    const rows = labServingRows({
      modelProjects: [
        {
          id: "model_1",
          name: "Support model",
        },
      ],
      modelVersions: [
        {
          artifactLineageId: "lineage_1",
          version: 2,
        },
      ],
      models: [
        {
          id: "lineage_1",
          modelId: "model_1",
          importedAt: "2026-07-30T10:00:00.000Z",
          managedServing: {
            state: "ready",
            lastSyncedAt: "2026-07-30T11:00:00.000Z",
          },
        },
      ],
    } as unknown as TrainingStateResponse);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lineageId: "lineage_1",
      modelName: "Support model",
      versionLabel: "Version 2",
      managed: { state: "ready" },
    });
  });

  test("creates a standalone Model without requiring a run", () => {
    const baseModelCandidates = [
      modelCandidate({
        selectionKey: "managed_qwen",
        label: "Qwen 3 0.6B",
        modelId: "Qwen/Qwen3-0.6B",
        source: "managed",
        sourceLabel: "OpenPond Managed",
      }),
      modelCandidate({
        available: false,
        selectionKey: "unavailable_qwen",
        label: "Qwen 3 8B",
        modelId: "Qwen/Qwen3-0.6B",
        source: "managed",
        sourceLabel: "OpenPond Managed",
      }),
      modelCandidate({
        selectionKey: "cpu_fixture",
        label: "Tiny CPU correctness fixture",
        modelId: "openpond/tiny-cpu-gpt2-fixture",
        nonProduction: true,
        source: "builtin",
        sourceLabel: "This machine",
      }),
    ];
    const markup = renderToStaticMarkup(
      createElement(LabModelCreateDialog, {
        baseModelCandidates,
        busy: false,
        defaultBenchmarkModel: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        initialName: "Model 1",
        onClose: noop,
        onCreate: async () => true,
        onManageModels: noop,
        providerSettings: null,
      }),
    );

    expect(markup).toContain("New model");
    expect(markup).toContain("Tasksets, runs, and releases can be added later.");
    expect(markup).toContain("Starting model");
    expect(markup).toContain("Choose later");
    expect(markup).toContain('aria-label="Add starting model"');
    expect(
      labModelCreateCandidates(baseModelCandidates).map(
        (candidate) => candidate.selectionKey
      )
    ).toEqual(["managed_qwen", "unavailable_qwen"]);
    expect(markup).not.toContain("labs-rename-dialog-icon");
    expect(markup).not.toContain("first run");
  });

  test("keeps Taskset Lab focused on review instead of a builder", () => {
    const markup = renderToStaticMarkup(
      createElement(LabDatasetsPage, {
        defaultModel: {
          providerId: "openrouter",
          modelId: "test/model",
        },
        runs: [],
        selectedId: null,
        state: null,
        training: {} as never,
        onToast: noop,
        onSelectedIdChange: noop,
        onImproveInChat: noop,
        onTrainModel: noop,
        onOpenFiles: noop,
      }),
    );

    expect(markup).toContain('aria-label="Search Tasksets"');
    expect(markup).not.toContain(">Build</button>");
    expect(markup).not.toContain("Embedded Taskset builder");
  });

  test("shows resumable drafts in the normal Taskset table", () => {
    const draft = {
      ...createTasksetDraft({
        id: "taskset-layered-artifact-v1-draft",
        profileId: "artifact-lab",
        name: "Layered artifact v1",
        now: "2026-08-24T12:00:00.000Z",
      }),
      objective: "Choose six compatible visual traits.",
    };
    const markup = renderToStaticMarkup(
      createElement(LabDatasetsPage, {
        defaultModel: { providerId: "openpond", modelId: "openpond-chat" },
        runs: [],
        selectedId: null,
        state: {
          profileId: "artifact-lab",
          tasksetDrafts: [draft],
          tasksets: [],
          modelTasksets: [],
        } as unknown as TrainingStateResponse,
        training: { loading: false, refresh: async () => null } as never,
        onToast: noop,
        onSelectedIdChange: noop,
        onOpenDraft: noop,
        onImproveInChat: noop,
        onTrainModel: noop,
        onOpenFiles: noop,
      }),
    );

    expect(markup).toContain("Layered artifact v1");
    expect(markup).toContain("Draft</span>");
    expect(markup).toContain("Resume draft");
    expect(markup).toContain("Choose six compatible visual traits.");
  });

  test("uses Taskset language in Lab breadcrumbs", () => {
    const breadcrumbs = buildLabDetailBreadcrumbs(
      {
        kind: "dataset",
        kindLabel: "Tasksets",
        workproductLabel: "Evaluation cases",
        segments: [],
      },
      noop,
    );

    expect(breadcrumbs.map((breadcrumb) => breadcrumb.label)).toEqual([
      "Models",
      "Tasksets",
      "Evaluation cases",
    ]);
  });

  test("reviews exact expert trajectories before bootstrap", () => {
    const preview = CrossSystemExpertBootstrapPreviewSchema.parse({
      schemaVersion: "openpond.crossSystemExpertBootstrapPreview.v1",
      tasksetId: "taskset_cross_system",
      tasksetHash: "tasksethash0001",
      tasksetRevision: 1,
      previewHash: "previewhash0001",
      toolContractHash: "openpond.crossSystemTools.v1:c864017226c97106",
      status: "ready_for_review",
      approval: null,
      tasks: [
        {
          tasksetTaskId: "task_renewal",
          environmentTaskId: "environment_task_renewal",
          family: "renewal_exposure",
          prompt: "Find renewal exposure.",
          finalAnswer: 'ANSWER: {"account_ids":["account_1"]}',
          trajectoryId: "trajectory_renewal",
          trajectoryHash: "trajectoryhash0001",
          toolNames: [
            "search_crm",
            "query_billing",
            "search_support",
            "run_python",
          ],
          toolCallCount: 4,
          messageCount: 4,
          reward: 1.1,
          messages: [
            { role: "system", content: "Use tools." },
            { role: "user", content: "Find renewal exposure." },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_crm",
                  type: "function",
                  function: {
                    name: "search_crm",
                    arguments: "{}",
                  },
                },
              ],
            },
            {
              role: "assistant",
              content: 'ANSWER: {"account_ids":["account_1"]}',
            },
          ],
        },
      ],
    });
    const markup = renderToStaticMarkup(
      createElement(ExpertTrajectoryDialog, {
        preview,
        loading: false,
        approving: false,
        onApprove: noop,
        onClose: noop,
      }),
    );

    expect(markup).toContain("Review expert trajectories");
    expect(markup).toContain("Renewal Exposure");
    expect(markup).toContain("4 tool calls");
    expect(markup).toContain("Approve 1 trajectories");
    expect(markup).toContain("failed policy outputs excluded");
  });

  test("renders an inspectable Taskset and its evaluation controls", () => {
    const taskset = tasksetFixture({ ready: true });
    const markup = renderToStaticMarkup(
      createElement(LabModelDataset, {
        artifact: null,
        defaultModel: {
          providerId: "openrouter",
          modelId: "test/model",
        },
        tab: "metrics",
        taskset,
        onOpenFiles: noop,
        onToast: noop,
        training: {
          actions: {
            datasetRows: async () => null,
            auditGraders: async () => null,
            refreshReadiness: async () => null,
          },
        } as never,
      }),
    );

    expect(markup).toContain("Evaluation metrics");
    expect(markup).toContain("Graders and reward gates");
    expect(markup).toContain("Audit graders");
    expect(markup).toContain("Refresh readiness");
  });

  test("does not expose benchmark installation as a Tasksets UI action", () => {
    const markup = renderToStaticMarkup(
      createElement(LabDatasetsPage, {
        defaultModel: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        runs: [],
        selectedId: null,
        state: {
          tasksets: [],
          plans: [],
          jobs: [],
          models: [],
        } as unknown as TrainingStateResponse,
        training: {
          busyAction: null,
          actions: {},
        } as never,
        onToast: noop,
        onSelectedIdChange: noop,
        onImproveInChat: noop,
        onTrainModel: noop,
        onOpenFiles: noop,
      }),
    );

    expect(markup).not.toContain("Add Harness Refiner benchmark");
  });

  test("renders paired benchmark controls as a Taskset scoring workflow", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = {
      ...base,
      purpose: "benchmark" as const,
      benchmark: {
        schemaVersion: "openpond.tasksetBenchmark.v1" as const,
        definitionId: "harness-refiner",
        releaseId: "harness-refiner-08112026",
        releaseHash: "a".repeat(64),
        managedReleasePath: "benchmark/taskset.release.json",
        adaptationSplit: "validation" as const,
        evaluationSplit: "frozen_eval" as const,
        primaryMetric: "foreground_tokens" as const,
        qualityGate: "non_regression" as const,
        source: "builtin" as const,
        metadata: {},
      },
    };
    const markup = renderToStaticMarkup(
      createElement(LabModelDataset, {
        artifact: null,
        defaultModel: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        tab: "metrics",
        taskset,
        onOpenFiles: noop,
        onToast: noop,
        training: {
          busyAction: null,
          actions: {
            datasetRows: async () => null,
            runBenchmark: async () => null,
            auditGraders: async () => null,
            refreshReadiness: async () => null,
          },
        } as never,
      }),
    );

    expect(markup).toContain("Benchmark runs");
    expect(markup).toContain("Run Refiner Benchmark");
    expect(markup).toContain("Open a Model");
    expect(markup).not.toContain("Run Baseline");
    expect(markup).not.toContain("Run Candidate");
    expect(markup).not.toContain("Train Model");
  });

  test("shows a shipped benchmark as runnable but not authorable", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = {
      ...base,
      purpose: "benchmark" as const,
      benchmark: {
        schemaVersion: "openpond.tasksetBenchmark.v1" as const,
        definitionId: "harness-refiner",
        releaseId: "harness-refiner-08112026",
        releaseHash: "a".repeat(64),
        managedReleasePath: "benchmark/taskset.release.json",
        adaptationSplit: "validation" as const,
        evaluationSplit: "frozen_eval" as const,
        primaryMetric: "foreground_tokens" as const,
        qualityGate: "non_regression" as const,
        source: "builtin" as const,
        metadata: {},
      },
    };
    const markup = renderToStaticMarkup(
      createElement(LabDatasetsPage, {
        defaultModel: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        runs: [],
        selectedId: taskset.id,
        state: {
          profileId: taskset.profileId,
          tasksets: [taskset],
          plans: [],
          jobs: [],
          models: [],
          modelTasksets: [],
          datasetArtifacts: [],
          modelProjects: [],
          benchmarkRuns: [],
          benchmarkComparisons: [],
        } as unknown as TrainingStateResponse,
        training: {
          busyAction: null,
          actions: {},
        } as never,
        onToast: noop,
        onSelectedIdChange: noop,
        onImproveInChat: noop,
        onTrainModel: noop,
        onOpenFiles: noop,
      }),
    );

    expect(markup).toContain("Run Benchmark");
    expect(markup).not.toContain("Improve in Chat");
    expect(markup).not.toContain("Train Model");
  });

  test("uses semantic status tones", () => {
    expect(labStatusTone("Ready")).toBe("positive");
    expect(labStatusTone("planning")).toBe("info");
    expect(labStatusTone("awaiting_plan_approval")).toBe("warning");
    expect(labStatusTone("failed")).toBe("negative");
    expect(labStatusTone("cancelled")).toBe("neutral");
  });

  test("shows an active training job ahead of stale authoring state", () => {
    const taskset = tasksetFixture({ ready: true });
    const plan = planFixture(taskset);
    const authoringRun = createImproveRunFixture({
      state: "evaluating",
      target: {
        kind: "model",
        id: taskset.id,
        displayName: taskset.name,
        trainingPlanId: null,
        trainingJobId: null,
        artifactId: null,
      },
    });
    const training = {
      tasksets: [taskset],
      plans: [plan],
      jobs: [
        {
          id: "training_job_active",
          planId: plan.id,
          status: "running",
          createdAt: "2026-07-18T01:00:00.000Z",
          updatedAt: "2026-07-18T01:01:00.000Z",
          metadata: { trainingMethod: "grpo" },
        },
      ],
      models: [],
    } as unknown as TrainingStateResponse;
    const [workproduct] = labWorkproductProjection({
      profile: null,
      training,
      runs: [authoringRun],
    });

    expect(
      labWorkproductProgression({
        workproduct: workproduct!,
        runs: [authoringRun],
        taskset,
        training,
      }),
    ).toMatchObject({
      statusLabel: "Running",
      statusValue: "running",
      action: { kind: "open_training", label: "View run" },
    });
  });
});
