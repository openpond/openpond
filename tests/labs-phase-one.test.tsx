import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  CrossSystemExpertBootstrapPreviewSchema,
  type TrainingStateResponse,
} from "@openpond/contracts";
import { LabsView } from "../apps/web/src/components/labs/LabsView";
import { LabDatasetsPage } from "../apps/web/src/components/labs/LabDatasetsPage";
import { ExpertTrajectoryDialog } from "../apps/web/src/components/labs/LabExpertBootstrap";
import { LabModelDataset } from "../apps/web/src/components/labs/LabModelDataset";
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

describe("Lab workspace", () => {
  test("renders first-class Taskset and Model tabs", () => {
    const markup = renderToStaticMarkup(
      createElement(LabsView, {
        activeTab: "workproducts",
        suggestionCount: 3,
        onTabChange: noop,
        onCreateAgent: noop,
        onCreateDataset: noop,
        onCreateModel: noop,
        children: createElement("div", null, "Unified inventory"),
      }),
    );

    expect(markup).toContain('aria-label="Lab"');
    expect(markup).toContain(">Home<");
    expect(markup).toContain(">Tasksets<");
    expect(markup).toContain(">Models<");
    expect(markup).toContain(">Suggestions<");
    expect(markup).toContain("Unified inventory");
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
        tab: "evals",
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
