import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  type BaseModelCandidate,
  CrossSystemExpertBootstrapPreviewSchema,
  type TrainingStateResponse,
} from "@openpond/contracts";
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
      : "local_cpu_fixture";
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

  test("keeps temporary sessions and managed publication separate in Serving", () => {
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
      servingSessions: [
        {
          id: "serving_1",
          modelArtifactLineageId: "lineage_1",
          state: "ready",
          updatedAt: "2026-07-30T12:00:00.000Z",
        },
      ],
    } as unknown as TrainingStateResponse);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lineageId: "lineage_1",
      modelName: "Support model",
      versionLabel: "Version 2",
      session: { id: "serving_1", state: "ready" },
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
        modelId: "accounts/fireworks/models/qwen3-8b",
        source: "managed",
        sourceLabel: "Fireworks",
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
        initialName: "Model 1",
        onClose: noop,
        onCreate: async () => true,
        onManageModels: noop,
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
        tab: "scoring",
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

    expect(markup).toContain("Taskset checks");
    expect(markup).toContain("Audit graders");
    expect(markup).toContain("Refresh readiness");
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
