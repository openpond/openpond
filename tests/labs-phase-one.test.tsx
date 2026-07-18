import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  CrossSystemExpertBootstrapPreviewSchema,
  CrossSystemFrontierBaselineRunSchema,
  emptyOpenPondProfileState,
  TrainingStateResponseSchema,
  type TrainingStateResponse,
} from "@openpond/contracts";

import { LabsView } from "../apps/web/src/components/labs/LabsView";
import { LabAgentRenameDialog } from "../apps/web/src/components/labs/LabAgentRenameDialog";
import { LabAgentChanges } from "../apps/web/src/components/labs/LabAgentChanges";
import { LabAgentChangeHistory } from "../apps/web/src/components/labs/LabAgentChangeHistory";
import { ComposerCreateImproveStrip } from "../apps/web/src/components/chat/ComposerCreateImproveStrip";
import {
  frontierBaselineMatchesCurrentTaskset,
  labWorkproductProjection,
  runsForWorkproduct,
} from "../apps/web/src/components/labs/lab-workproducts";
import { labWorkproductProgression } from "../apps/web/src/components/labs/lab-workproduct-progression";
import { labStatusTone } from "../apps/web/src/components/labs/LabStatusBadge";
import {
  LabModelBaselineData,
  LabModelBaselineEvals,
  LabModelBaselineProgress,
} from "../apps/web/src/components/labs/LabModelBaseline";
import { LabModelDataset } from "../apps/web/src/components/labs/LabModelDataset";
import { ExpertTrajectoryDialog } from "../apps/web/src/components/labs/LabExpertBootstrap";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";
import { planFixture, tasksetFixture } from "./helpers/training-fixtures";

const noop = () => undefined;

describe("Lab Phase 1", () => {
  test("reviews exact expert trajectories in a normal-cased approval dialog", () => {
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
                  function: { name: "search_crm", arguments: "{}" },
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
      })
    );

    expect(markup).toContain("Review expert trajectories");
    expect(markup).toContain("Renewal Exposure");
    expect(markup).toContain("Tool sequence");
    expect(markup).toContain("search_crm");
    expect(markup).toContain("query_billing");
    expect(markup).toContain("search_support");
    expect(markup).toContain("run_python");
    expect(markup).toContain("4 tool calls");
    expect(markup).toContain("Approve 1 trajectories");
    expect(markup).toContain("failed policy outputs excluded");
    expect(markup).not.toContain("REVIEW EXPERT TRAJECTORIES");
  });

  test("renders the single-profile Lab tabs and registered create menu", () => {
    const markup = renderToStaticMarkup(
      createElement(LabsView, {
        activeTab: "workproducts",
        suggestionCount: 3,
        onTabChange: noop,
        onCreateAgent: noop,
        onCreateDataset: noop,
        onCreateModel: noop,
        children: createElement("div", null, "Unified inventory"),
      })
    );

    expect(markup).toContain('aria-label="Lab"');
    expect(markup).toContain(">Home<");
    expect(markup).toContain(">Datasets<");
    expect(markup).toContain(">Suggestions<");
    expect(markup).not.toContain(">Models<");
    expect(markup).not.toContain(">Profile<");
    expect(markup).toContain("Unified inventory");
    expect(markup).toContain('role="tablist"');
    expect(markup).not.toContain("Profile ready");
    expect(markup).not.toContain(">Agents</button>");
  });

  test("routes Agent create, Agent improve, Model, and Dataset through one authoring shell", async () => {
    const [route, dialog] = await Promise.all([
      readFile("apps/web/src/components/labs/LabsRoute.tsx", "utf8"),
      readFile(
        "apps/web/src/components/create-improve/CreateImproveAuthoringDialog.tsx",
        "utf8"
      ),
    ]);
    expect(route.match(/<CreateImproveAuthoringDialog/g)).toHaveLength(5);
    expect(route).toContain("initialCreation={resumedModelCreation}");
    expect(route).toContain(
      'targetIntent={{ kind: "agent", id: null, displayName: null, operation: "create" }}'
    );
    expect(route).toContain('operation: "improve"');
    expect(route).toContain('resourceIntent="dataset"');
    expect(route).toContain("kind: null");
    expect(route).not.toContain("LabAgentCreateDialog");
    expect(route).not.toContain("LabAgentImproveDialog");
    expect(route).not.toContain("genericCreateOpen");
    expect(route).not.toContain("onCreateGeneric");
    expect(dialog).not.toContain("window.confirm");
    expect(dialog).not.toContain("current selections will be discarded");
  });

  test("uses solid semantic status tones", () => {
    expect(labStatusTone("Ready")).toBe("positive");
    expect(labStatusTone("planning")).toBe("info");
    expect(labStatusTone("awaiting_plan_approval")).toBe("warning");
    expect(labStatusTone("failed")).toBe("negative");
    expect(labStatusTone("cancelled")).toBe("neutral");
  });

  test("projects a live baseline as a selectable Model with inline progress", () => {
    const run = CrossSystemFrontierBaselineRunSchema.parse({
      schemaVersion: "openpond.crossSystemFrontierBaselineRun.v1",
      id: "cso_frontier_run_live",
      profileId: "default",
      createImproveRunId: "create_improve_cross_system",
      localProjectId: "project_cross_system",
      localProjectName: "Cross-System Operations",
      model: { providerId: "openpond", modelId: "openai/gpt-5-mini" },
      reasoningEffort: "medium",
      worldSpecs: Array.from({ length: 15 }, (_, index) => ({
        seed: index,
        split: index < 9 ? "train" : index < 12 ? "validation" : "frozen_eval",
        difficulty:
          index % 3 === 0 ? "easy" : index % 3 === 1 ? "medium" : "hard",
      })),
      status: "running",
      progress: {
        stage: "running",
        completedTasks: 9,
        totalTasks: 15,
        currentTask: {
          index: 9,
          taskId: "task_contract_mismatch",
          worldId: "world_validation_9",
          family: "contract_billing_mismatch",
        },
        outcomes: {
          correct: 0,
          incorrect: 3,
          parseFailure: 4,
          budgetExhausted: 0,
          toolSchemaViolation: 0,
          infrastructureFailure: 2,
          cancelled: 0,
        },
      },
      sourceIds: [],
      reboundSessionCount: 0,
      result: null,
      cancelRequested: false,
      error: null,
      createdAt: "2026-07-17T12:00:00.000Z",
      startedAt: "2026-07-17T12:00:01.000Z",
      completedAt: null,
      updatedAt: "2026-07-17T12:05:00.000Z",
    });
    const authoringRun = createImproveRunFixture({
      id: "create_improve_cross_system",
      target: {
        kind: "model",
        id: "model_draft_cross_system",
        displayName: "Cross-System Operations",
        trainingPlanId: null,
        trainingJobId: null,
        artifactId: null,
      },
      objective: "Improve deterministic CRM, billing, and support operations.",
    });
    const [workproduct] = labWorkproductProjection({
      profile: null,
      training: {
        ...TrainingStateResponseSchema.parse({
          schemaVersion: "openpond.trainingState.v1",
          profileId: "default",
          sources: [],
          creations: [],
          tasksets: [],
          baselineReports: [],
          graderAuditReports: [],
          candidates: [],
          minerConfig: { schemaVersion: "openpond.taskMinerConfig.v1" },
          plans: [],
          bundles: [],
          jobs: [],
          artifacts: [],
          models: [],
          destinations: [],
          credentialRefs: [],
          generatedAt: "2026-07-17T12:05:00.000Z",
        }),
        frontierBaselineRuns: [run],
      },
      runs: [authoringRun],
    });
    const markup = renderToStaticMarkup(
      createElement(LabModelBaselineProgress, { run })
    );

    expect(workproduct).toMatchObject({
      kind: "model",
      name: "Cross-System Operations",
      frontierBaselineRunId: "cso_frontier_run_live",
    });
    expect(markup).toContain("9 / 15 · Contract Billing Mismatch");
    expect(markup).toContain("Contract Billing Mismatch");
    expect(markup).toContain("<progress");
    expect(markup).toContain("0 exact · 3 incorrect");
    expect(markup).not.toContain("LIVE ACTIVITY");
  });

  test("keeps baseline Data and Evals tab content distinct", () => {
    const run = CrossSystemFrontierBaselineRunSchema.parse({
      schemaVersion: "openpond.crossSystemFrontierBaselineRun.v1",
      id: "cso_frontier_run_tabs",
      profileId: "default",
      createImproveRunId: "create_improve_cross_system",
      localProjectId: "project_cross_system",
      localProjectName: "Cross-System Operations",
      model: { providerId: "openpond", modelId: "openai/gpt-5-mini" },
      reasoningEffort: "medium",
      worldSpecs: [
        { seed: 301, split: "train", difficulty: "easy" },
        { seed: 302, split: "validation", difficulty: "medium" },
        { seed: 303, split: "frozen_eval", difficulty: "hard" },
      ],
      status: "succeeded",
      progress: {
        stage: "complete",
        completedTasks: 15,
        totalTasks: 15,
        currentTask: null,
        outcomes: {
          correct: 0,
          incorrect: 5,
          parseFailure: 4,
          budgetExhausted: 0,
          toolSchemaViolation: 1,
          infrastructureFailure: 5,
          cancelled: 0,
        },
      },
      sourceIds: Array.from({ length: 15 }, (_, index) => `source_${index}`),
      reboundSessionCount: 0,
      result: null,
      cancelRequested: false,
      error: null,
      createdAt: "2026-07-17T12:00:00.000Z",
      startedAt: "2026-07-17T12:00:01.000Z",
      completedAt: "2026-07-17T12:15:00.000Z",
      updatedAt: "2026-07-17T12:15:00.000Z",
    });
    const dataMarkup = renderToStaticMarkup(
      createElement(LabModelBaselineData, { run })
    );
    const evalMarkup = renderToStaticMarkup(
      createElement(LabModelBaselineEvals, { run })
    );

    expect(dataMarkup).toContain("Dataset splits");
    expect(dataMarkup).toContain("15</strong> recorded trajectories");
    expect(dataMarkup).not.toContain("<dt>Incorrect</dt>");
    expect(dataMarkup).not.toContain("Each deterministic world records");
    expect(evalMarkup).toContain("Cross-System baseline");
    expect(evalMarkup).toContain("<dt>Incorrect</dt><dd>5</dd>");
    expect(evalMarkup).not.toContain("Dataset splits");
    expect(evalMarkup).not.toContain("The baseline is complete");
  });

  test("renders generated model data as an inspectable Dataset instead of dead Evidence rows", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = {
      ...base,
      sourceRefs: base.sourceRefs.map((source) => ({
        ...source,
        turnIds: [],
        title: "Synthetic CRM scenario: renewal exposure",
        metadata: {
          syntheticSpecification: true,
          containsCustomerData: false,
          crossSystemOperations: {
            taskFamily: "renewal_exposure",
            worldDifficulty: "medium",
          },
        },
      })),
    };
    const markup = renderToStaticMarkup(
      createElement(LabModelDataset, {
        taskset,
        onOpenFiles: noop,
      }),
    );

    expect(markup).toContain(">Dataset<");
    expect(markup).toContain("uses no raw chats or customer data");
    expect(markup).toContain('aria-label="Dataset splits"');
    expect(markup).toContain(">Training<");
    expect(markup).toContain("Say hello");
    expect(markup).toContain("Generated scenario");
    expect(markup).toContain("Approved answer");
    expect(markup).toContain("Hello friend");
    expect(markup).toContain('class="labs-dataset-example"');
    expect(markup).not.toContain(">Evidence<");
  });

  test("does not project a completed baseline from an older Taskset revision", () => {
    const taskset = tasksetFixture();
    const baseRun = CrossSystemFrontierBaselineRunSchema.parse({
      schemaVersion: "openpond.crossSystemFrontierBaselineRun.v1",
      id: "cso_frontier_run_stale",
      profileId: "default",
      createImproveRunId: null,
      localProjectId: "project_cross_system",
      localProjectName: "Cross-System Operations",
      model: { providerId: "openpond", modelId: "openpond-chat" },
      reasoningEffort: null,
      worldSpecs: [
        { seed: 301, split: "train", difficulty: "easy" },
        { seed: 302, split: "validation", difficulty: "medium" },
        { seed: 303, split: "frozen_eval", difficulty: "hard" },
      ],
      status: "succeeded",
      progress: {
        stage: "complete",
        completedTasks: 15,
        totalTasks: 15,
        currentTask: null,
        outcomes: {
          correct: 1,
          incorrect: 14,
          parseFailure: 0,
          budgetExhausted: 0,
          toolSchemaViolation: 0,
          infrastructureFailure: 0,
          cancelled: 0,
        },
      },
      sourceIds: ["source_from_prior_revision"],
      reboundSessionCount: 0,
      result: null,
      cancelRequested: false,
      error: null,
      createdAt: "2026-07-17T12:00:00.000Z",
      startedAt: "2026-07-17T12:00:01.000Z",
      completedAt: "2026-07-17T12:15:00.000Z",
      updatedAt: "2026-07-17T12:15:00.000Z",
    });

    expect(frontierBaselineMatchesCurrentTaskset(baseRun, taskset)).toBe(false);
    expect(frontierBaselineMatchesCurrentTaskset(
      CrossSystemFrontierBaselineRunSchema.parse({
        ...baseRun,
        sourceIds: taskset.sourceRefs.map((source) => source.id),
      }),
      taskset,
    )).toBe(true);
  });

  test("projects Agents, Skills, Models, and draft runs into one workproduct inventory", () => {
    const profile = {
      ...emptyOpenPondProfileState(),
      mode: "local" as const,
      activeProfile: "default",
      agents: [
        {
          id: "support",
          name: "Support",
          path: "agents/support",
          enabled: true,
        },
      ],
      skills: [
        {
          name: "triage",
          description: "Triage incoming work.",
          path: "skills/triage",
          scope: "profile" as const,
          enabled: true,
          sourcePath: "/profile/skills/triage/SKILL.md",
          charCount: 120,
          sourceHash: "hash",
          validationStatus: "valid" as const,
          validationMessages: [],
        },
      ],
    };
    const draft = createImproveRunFixture({
      id: "create_improve_extension",
      target: {
        kind: "extension",
        id: "search-ranking",
        displayName: "Search ranking",
        slot: "resource_search.strategy",
      },
      objective: "Improve ranked search.",
    });
    const workproducts = labWorkproductProjection({
      profile,
      training: null,
      runs: [draft],
    });

    expect(workproducts.map((item) => item.key)).toEqual([
      "extension:search-ranking",
      "agent:support",
      "skill:triage",
    ]);
    expect(workproducts[0]).toMatchObject({
      name: "Search ranking",
      status: "planning",
      runIds: ["create_improve_extension"],
    });
  });

  test("projects concise model names and keeps the full objective as the description", () => {
    const objective =
      "Reconcile CRM billing and support records with exact cited customer evidence.";
    const draft = createImproveRunFixture({
      id: "create_improve_model_name",
      target: {
        kind: "model",
        id: "model_draft_name",
        displayName: objective,
        trainingPlanId: null,
        trainingJobId: null,
        artifactId: null,
      },
      objective,
    });
    const [workproduct] = labWorkproductProjection({
      profile: null,
      training: null,
      runs: [draft],
    });

    expect(workproduct?.name).toBe("Reconcile CRM billing and support");
    expect(workproduct?.description).toBe(objective);
  });

  test("derives one workproduct status and next action while preserving completed history", () => {
    const active = createImproveRunFixture({
      id: "create_improve_active",
      state: "awaiting_plan_approval",
    });
    const ready = createImproveRunFixture({
      id: "create_improve_ready",
      state: "ready_local",
      target: active.target,
    });
    const workproducts = labWorkproductProjection({
      profile: null,
      training: null,
      runs: [ready, active],
    });
    const workproductRuns = runsForWorkproduct(workproducts[0]!, [
      ready,
      active,
    ]);
    const progression = labWorkproductProgression({
      workproduct: workproducts[0]!,
      runs: workproductRuns,
      taskset: null,
      training: null,
    });

    expect(progression).toMatchObject({
      statusLabel: "Plan ready",
      statusValue: "awaiting_plan_approval",
      action: { kind: "review_run", label: "Review plan" },
      runId: "create_improve_active",
    });
    expect(workproducts[0]?.runIds).toEqual([
      "create_improve_ready",
      "create_improve_active",
    ]);
  });

  test("continues an authored blocked candidate instead of starting over", () => {
    const run = createImproveRunFixture({
      id: "create_improve_resume_candidate",
      operation: "improve",
      state: "blocked",
      candidates: [
        {
          id: "agent_candidate_resume",
          target: {
            kind: "agent",
            id: "fixture-agent",
            displayName: "Fixture Agent",
            defaultActionKey: "fixture-agent.chat",
          },
          status: "checking",
          git: {
            baseBranch: "main",
            baseCommit: "a".repeat(40),
            branch: "openpond/improve/fixture",
            headCommit: null,
            remoteName: "origin",
            remoteUrl: null,
            worktreePath: "/tmp/openpond-agent-candidate",
            changedPaths: [],
            diffStat: null,
            pullRequest: null,
          },
          sourceRefs: [],
          artifactRefs: [],
          checkRefs: [],
          evaluationReceiptRefs: [],
          createdAt: "2026-07-16T12:00:00.000Z",
          updatedAt: "2026-07-16T12:00:00.000Z",
          metadata: {},
        },
      ],
    });
    const [workproduct] = labWorkproductProjection({
      profile: null,
      training: null,
      runs: [run],
    });

    expect(
      labWorkproductProgression({
        workproduct: workproduct!,
        runs: [run],
        taskset: null,
        training: null,
      }).action
    ).toEqual({ kind: "resume_run", label: "Continue candidate" });
  });

  test("makes Model data and training part of the same status-aware workproduct flow", () => {
    const draftTaskset = tasksetFixture();
    const readyTaskset = tasksetFixture({ ready: true });
    const workproduct = {
      key: `model:${draftTaskset.id}`,
      kind: "model" as const,
      id: draftTaskset.id,
      name: "Fixture model",
      description: "Fixture Taskset",
      status: "Needs review",
      updatedAt: draftTaskset.updatedAt,
      path: `tasksets/${draftTaskset.id}`,
      enabled: null,
      runIds: [],
      conversationId: null,
      tasksetId: draftTaskset.id,
    };

    expect(
      labWorkproductProgression({
        workproduct,
        runs: [],
        taskset: draftTaskset,
        training: null,
      }).action
    ).toEqual({ kind: "open_data", label: "Review data" });
    expect(
      labWorkproductProgression({
        workproduct,
        runs: [],
        taskset: readyTaskset,
        training: null,
      }).action
    ).toEqual({ kind: "start_training", label: "Start training" });
  });

  test("shows an active training job instead of a stale authoring state", () => {
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
      jobs: [{
        id: "training_job_active",
        planId: plan.id,
        status: "running",
        createdAt: "2026-07-18T01:00:00.000Z",
        updatedAt: "2026-07-18T01:01:00.000Z",
        metadata: { trainingMethod: "grpo" },
      }],
      models: [],
      frontierBaselineRuns: [],
    } as unknown as TrainingStateResponse;
    const [workproduct] = labWorkproductProjection({
      profile: null,
      training,
      runs: [authoringRun],
    });

    expect(labWorkproductProgression({
      workproduct: workproduct!,
      runs: [authoringRun],
      taskset,
      training,
    })).toMatchObject({
      statusLabel: "Running",
      statusValue: "running",
      action: { kind: "open_training", label: "View run" },
    });
  });

  test("keeps failed frozen-eval Models visible but blocks Chat", () => {
    const taskset = tasksetFixture({ ready: true });
    const plan = planFixture(taskset);
    const training = {
      tasksets: [taskset],
      plans: [plan],
      jobs: [{
        id: "training_job_failed_eval",
        planId: plan.id,
        status: "succeeded",
        metadata: {
          frozenEvaluationComplete: true,
          frozenEvaluationThresholdPassed: false,
        },
        updatedAt: "2026-07-17T23:00:00.000Z",
      }],
      models: [{
        id: "lineage_failed_eval",
        tasksetId: taskset.id,
        jobId: "training_job_failed_eval",
        status: "imported",
        promotable: false,
        importedAt: "2026-07-17T23:00:00.000Z",
      }],
      frontierBaselineRuns: [],
    } as unknown as TrainingStateResponse;
    const [workproduct] = labWorkproductProjection({
      profile: null,
      training,
      runs: [],
    });

    expect(workproduct?.enabled).toBe(false);
    expect(workproduct?.evaluationStatus).toBe("failed");
    expect(
      labWorkproductProgression({
        workproduct: workproduct!,
        runs: [],
        taskset,
        training,
      })
    ).toMatchObject({
      statusLabel: "Evaluation failed",
      statusValue: "failed",
      action: { kind: "open_training", label: "Review results" },
    });
  });

  test("does not project a failed authoring operation without a Dataset as a Model", () => {
    const failed = createImproveRunFixture({
      state: "failed",
      target: {
        kind: "model",
        id: "model_draft_failed",
        displayName: "Failed model",
        trainingPlanId: null,
        trainingJobId: null,
        artifactId: null,
      },
      blockedReason: "terminated",
    });
    const workproducts = labWorkproductProjection({
      profile: null,
      training: null,
      runs: [failed],
    });
    expect(workproducts).toEqual([]);
  });

  test("keeps Create/Improve decisions and Model creation inside the Lab route", async () => {
    const route = await readFile(
      "apps/web/src/components/labs/LabsRoute.tsx",
      "utf8"
    );
    const detail = await readFile(
      "apps/web/src/components/labs/LabWorkproductDetail.tsx",
      "utf8"
    );
    const changes = await readFile(
      "apps/web/src/components/labs/LabAgentChanges.tsx",
      "utf8"
    );
    const decision = await readFile(
      "apps/web/src/components/labs/LabRunDecisionSection.tsx",
      "utf8"
    );
    const view = await readFile(
      "apps/web/src/components/labs/LabsView.tsx",
      "utf8"
    );
    const modelSections = await readFile(
      "apps/web/src/components/labs/LabModelDetailSections.tsx",
      "utf8"
    );
    const modelWorkspace = await readFile(
      "apps/web/src/components/labs/LabModelWorkspace.tsx",
      "utf8"
    );

    expect(route).toContain("<th>Type</th>");
    expect(route).toContain("<th>Name</th>");
    expect(route).toContain("<th>Training</th>");
    expect(route).toContain("<th>Evals</th>");
    expect(route).not.toContain("<th>Training / Evals</th>");
    expect(route).not.toContain("workproductActivity");
    expect(route).toContain("<ChartColumnStacked");
    expect(route).toContain("<CheckCircle2");
    expect(route).toContain("<LabAgentRenameDialog");
    expect(route).not.toContain("<th>Current work</th>");
    expect(route).toContain("<CreateImproveAuthoringDialog");
    expect(route).toContain("<TrainingSuggestions");
    expect(route).toContain("<ProfileView");
    expect(route).toContain('section="controls"');
    expect(route).toContain("onUseSkill");
    expect(route).not.toContain('"Search profile"');
    expect(route).not.toContain('"Filter workproduct type"');
    expect(route).toContain("showHeader={!selected && !selectedDatasetId}");
    expect(route).toContain('className="labs-home-models"');
    expect(route).not.toContain("homeModels.length ?");
    expect(detail).toContain("labWorkproductProgression");
    expect(decision).toContain("<ComposerCreateImproveStrip");
    expect(detail).toContain("<TrainingStartDialog");
    expect(detail).toContain("<LabAgentEvalActions");
    expect(detail).toContain("<LabAgentChangeHistory");
    expect(detail).toContain("persistedProfileAgent");
    expect(detail).toContain("detailBreadcrumbs(");
    expect(detail).toContain("selectedChangeCommit");
    expect(detail).toContain("workproductLabel: workproduct.name");
    expect(route).not.toContain("workproductLabel: null");
    expect(detail).toContain("Download LoRA");
    expect(detail).toContain("downloadModelPackage(model.id)");
    expect(detail).toContain('return ["Changes"]');
    expect(detail).toContain("`Change ${changeCommit.slice(0, 8)}`");
    expect(detail).toContain('className="labs-change-index"');
    expect(changes).toContain('className="labs-change-page"');
    expect(view).toContain('aria-label="Create workproduct"');
    expect(view).not.toContain("<strong>New change</strong>");
    expect(view).toContain("<strong>New skill</strong>");
    expect(view).toContain("<strong>New extension</strong>");
    expect(view.match(/<small>Coming soon<\/small>/g)).toHaveLength(2);
    expect(view.match(/<button disabled type="button" role="menuitem">/g)).toHaveLength(2);
    expect(detail).toContain("Improve agent");
    expect(detail).not.toContain("New change");
    expect(detail).not.toContain("labs-model-current-picker");
    expect(detail).not.toContain(
      'aria-label={`Current Version for ${workproduct.name}`}',
    );
    expect(detail).toContain("Available Evals");
    expect(detail).toContain("Used for this change");
    expect(detail).toContain("}, [workproduct.key]);");
    expect(modelSections).toContain("<TrainingRunMetrics");
    expect(modelSections).toContain("<TrainingRunEvaluation");
    expect(modelSections).toContain("<TrainingModelComparisons method={method}");
    expect(modelSections).toContain('title={`${trainingMethodLabel(method)} frozen Eval`}');
    expect(modelSections).toContain("buildTrainingModelChatHandoff");
    expect(modelSections).toContain("aria-label={`Chat with ${taskset.name}`}");
    expect(modelSections).toContain("disabled={!lineage.promotable}");
    expect(modelSections).toContain(
      "Chat is unavailable because this version did not pass frozen evaluation."
    );
    expect(detail).toContain("<LabModelVersionsPage");
    expect(detail).toContain("<LabModelVersionDetailPage");
    expect(detail).toContain("selectedModelEntryKey");
    expect(modelWorkspace).toContain('aria-label="Versions"');
    expect(modelWorkspace).toContain("Version status");
    expect(modelWorkspace).toContain("Back to versions");
    expect(modelWorkspace).not.toContain("Version history");
    expect(modelWorkspace).not.toContain(
      "Each training attempt is listed here.",
    );
    expect(modelWorkspace).toContain("<TrainingRunMetrics");
    expect(modelWorkspace).toContain("<TrainingRunEvaluation");
    expect(modelWorkspace).toContain("<TrainingRolloutReceipts");
    expect(modelWorkspace).toContain("Download LoRA");
    expect(modelWorkspace).toContain(
      "disabled={!selectedVersion.lineage.promotable}",
    );
    expect(modelWorkspace).toContain('title="Configuration"');
    expect(modelWorkspace).not.toContain("LabModelOverviewPage");
    expect(modelWorkspace).not.toContain("LabModelRunsPage");
    expect(detail).toContain('workproduct.kind !== "model" ? (');
    expect(detail).not.toContain('["runs", "Runs"]');
    expect(detail).not.toContain('["dataset", "Dataset"]');
    expect(detail).not.toContain('["training", "Training"]');
    expect(detail).not.toContain('title="Current work"');
    expect(route).not.toContain("LABS_TABS");
    expect(route).not.toContain("LabsExtensions");
  });

  test("presents Agent rename as a display-name edit with the stable ID visible", () => {
    const markup = renderToStaticMarkup(
      createElement(LabAgentRenameDialog, {
        agentId: "support-agent",
        currentName: "Support Agent",
        onClose: noop,
        onRename: async () => undefined,
      })
    );

    expect(markup).toContain("Rename agent");
    expect(markup).toContain("Display name");
    expect(markup).toContain("support-agent");
    expect(markup).toContain("stable agent ID");
  });

  test("allows right chat alongside Lab and uses breadcrumbs for detail navigation", async () => {
    const mainPane = await readFile(
      "apps/web/src/components/app-shell/MainPane.tsx",
      "utf8"
    );
    const app = await readFile("apps/web/src/App.tsx", "utf8");
    const navigation = await readFile(
      "apps/web/src/hooks/useLabDetailNavigation.ts",
      "utf8"
    );
    expect(mainPane).toContain('(view === "chat" || view === "labs")');
    expect(mainPane).toContain(
      "onOpenRunConversation={onOpenRightChatForSession}"
    );
    expect(mainPane).toContain("onCreateAgent={createAgentFromLab}");
    expect(mainPane).toContain('systemKind: "openpond.lab"');
    expect(mainPane).toContain("hiddenFromDefaultSidebar: true");
    expect(mainPane).toContain(
      "closeDetailRequestId={labCloseDetailRequestId}"
    );
    expect(app).toContain("backAction: labDetailNavigation.backAction");
    expect(app).toContain("breadcrumbs: labDetailNavigation.breadcrumbs");
    expect(navigation).toContain("const backAction = null");
    expect(navigation).not.toContain('label: "Back to Home"');
    expect(navigation).toContain('label: "Lab"');
    expect(navigation).toContain("detailLocation.workproductLabel");
  });

  test("shows the same local Agent merge decision in the shared Create/Improve controls", () => {
    const run = createImproveRunFixture({
      operation: "improve",
      state: "awaiting_promotion",
      candidates: [
        {
          id: "agent_candidate_fixture",
          target: {
            kind: "agent",
            id: "fixture-agent",
            displayName: "Fixture Agent",
            defaultActionKey: "fixture-agent.chat",
          },
          status: "evaluated",
          git: {
            baseBranch: "main",
            baseCommit: "a".repeat(40),
            branch: "openpond/improve/fixture",
            headCommit: "b".repeat(40),
            remoteName: "origin",
            remoteUrl: "git@github.com:openpond/profile.git",
            worktreePath: "/tmp/candidate",
            changedPaths: [
              "profiles/default/agents/fixture-agent/agent/agent.ts",
            ],
            diffStat: "1 file changed",
            pullRequest: null,
          },
          sourceRefs: [],
          artifactRefs: [],
          checkRefs: [],
          evaluationReceiptRefs: ["active_eval", "candidate_eval"],
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-01T10:00:00.000Z",
          metadata: {},
        },
      ],
      evaluationReceipts: [
        evalReceipt("active_eval", "active", "failed", 0),
        evalReceipt("candidate_eval", "candidate", "passed", 1),
      ],
    });
    const markup = renderToStaticMarkup(
      createElement(ComposerCreateImproveStrip, {
        runtime: { run },
      })
    );
    expect(markup).toContain("Candidate ready");
    expect(markup).toContain("Base Evals: 0/1 passed");
    expect(markup).toContain("Candidate Evals: 1/1 passed");
    expect(markup).toContain("Merge change");
    expect(markup).toContain("Reject");
  });

  test("renders Agent change review as request, changes, Evals, and merge without an inline file list", () => {
    const run = createImproveRunFixture({
      operation: "improve",
      objective: "Make the Agent better at finding files.",
      state: "awaiting_promotion",
      candidates: [
        {
          id: "agent_candidate_fixture",
          target: {
            kind: "agent",
            id: "fixture-agent",
            displayName: "Fixture Agent",
            defaultActionKey: "fixture-agent.chat",
          },
          status: "evaluated",
          git: {
            baseBranch: "main",
            baseCommit: "a".repeat(40),
            branch: "openpond/improve/fixture",
            headCommit: "b".repeat(40),
            remoteName: "origin",
            remoteUrl: null,
            worktreePath: "/tmp/candidate",
            changedPaths: ["profiles/default/agent/instructions.md"],
            diffStat: "1 file changed",
            pullRequest: null,
          },
          sourceRefs: [],
          artifactRefs: [],
          checkRefs: [],
          evaluationReceiptRefs: ["candidate_eval"],
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-01T10:00:00.000Z",
          metadata: {},
        },
      ],
      evaluationReceipts: [
        evalReceipt("candidate_eval", "candidate", "passed", 1),
      ],
    });
    const candidate = run.candidates[0]!;
    const markup = renderToStaticMarkup(
      createElement(LabAgentChanges, {
        candidate,
        diff: {
          appId: "candidate:fixture",
          repoPath: "/tmp/candidate",
          initialized: true,
          dirty: true,
          filesChanged: 1,
          additions: 3,
          deletions: 1,
          repoFiles: ["profiles/default/agent/instructions.md"],
          files: [
            {
              path: "profiles/default/agent/instructions.md",
              status: "modified",
              additions: 3,
              deletions: 1,
              patch: "fixture",
              content: "fixture",
            },
          ],
          error: null,
          updatedAt: "2026-07-01T10:00:00.000Z",
        },
        error: null,
        run,
        onApplyCandidate: async () => undefined,
        onOpenFiles: noop,
        onRejectCandidate: async () => undefined,
      })
    );

    expect(markup).toContain(">Request<");
    expect(markup).toContain(">Changes<");
    expect(markup).toContain(">Evals<");
    expect(markup).toContain(">Merge<");
    expect(markup).toContain("Files (1)");
    expect(markup).toContain("Base");
    expect(markup).toContain("Branch");
    expect(markup).toContain("Merge change");
    expect(markup).not.toContain("Review the drafted files and their Evals");
    expect(markup).not.toContain("Files changed");
    expect(markup).not.toContain("profiles/default/agent/instructions.md");
    expect(markup.indexOf(">Request<")).toBeLessThan(
      markup.indexOf(">Changes<")
    );
    expect(markup.indexOf(">Changes<")).toBeLessThan(
      markup.indexOf("Files (1)")
    );
    expect(markup.indexOf("Files (1)")).toBeLessThan(markup.indexOf(">Evals<"));
    expect(markup.indexOf(">Changes<")).toBeLessThan(markup.indexOf(">Evals<"));
    expect(markup.indexOf(">Evals<")).toBeLessThan(markup.indexOf(">Merge<"));

    const history = renderToStaticMarkup(
      createElement(LabAgentChangeHistory, {
        runs: [run],
        onReview: noop,
      })
    );
    expect(history).toContain("Make the Agent better at finding files.");
    expect(history).toContain("1/1 passed");
  });
});

function evalReceipt(
  id: string,
  subject: "active" | "candidate",
  status: "passed" | "failed",
  passed: number
) {
  return {
    id,
    candidateId: "agent_candidate_fixture",
    target: {
      kind: "agent" as const,
      id: "fixture-agent",
      displayName: "Fixture Agent",
      defaultActionKey: "fixture-agent.chat",
    },
    evaluatorKind: "agent_sdk" as const,
    subject,
    sourceCommit: subject === "active" ? "a".repeat(40) : "b".repeat(40),
    sourceBranch: subject === "active" ? "main" : "openpond/improve/fixture",
    status,
    publishGate:
      status === "passed" ? ("passed" as const) : ("failed" as const),
    summaryCounts: { total: 1, passed, failed: 1 - passed },
    evalRefs: ["fixture"],
    artifactRefs: [],
    summary: `${passed}/1 passed`,
    createdAt: "2026-07-01T10:00:00.000Z",
    metadata: {},
  };
}
