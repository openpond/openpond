import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  CrossSystemExpertBootstrapPreviewSchema,
  CrossSystemFrontierBaselineRunSchema,
  emptyOpenPondProfileState,
  TasksetSchema,
  TasksetBaselineRunSchema,
  TrainingStateResponseSchema,
  type OpenPondProfileState,
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
import {
  LabModelVersionDetailPage,
  LabModelVersionsPage,
} from "../apps/web/src/components/labs/LabModelWorkspace";
import { LabNewVersionDialog } from "../apps/web/src/components/labs/LabNewVersionDialog";
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
        artifact: null,
        taskset,
        onOpenFiles: noop,
        training: {
          actions: {
            datasetRows: async () => null,
          },
        } as any,
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

  test("shows failed train-signal checks on the current Dataset version", () => {
    const taskset = tasksetFixture({ ready: true });
    const run = TasksetBaselineRunSchema.parse({
      schemaVersion: "openpond.tasksetBaselineRun.v1",
      id: "baseline_run_capacity",
      profileId: "default",
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      status: "failed",
      configuration: {
        split: "train",
        taskLimit: 16,
        attemptsPerTask: 8,
        selectionSeed: 17,
        selectionStrategy: "stable_hash_top_n",
        model: { providerId: "fireworks", modelId: "accounts/fireworks/models/qwen3-0p6b" },
        sampling: { maxOutputTokens: 2_048, temperature: 0.8, topP: 0.95 },
      },
      scope: null,
      progress: {
        stage: "provisioning",
        completedAttempts: 0,
        totalAttempts: 128,
        correctAttempts: 0,
        incorrectAttempts: 0,
        parseableAttempts: 0,
        infrastructureFailures: 0,
      },
      provider: {
        providerId: "fireworks",
        accountId: "test-account",
        deploymentId: "op-baseline-capacity",
        phase: "deleted",
        state: "DELETED",
        statusCode: "RESOURCE_EXHAUSTED",
        statusMessage: "no available capacity",
        createdAt: "2026-07-21T12:00:00.000Z",
        readyAt: null,
        releasedAt: "2026-07-21T12:00:02.000Z",
      },
      reportId: null,
      estimatedCostUsd: null,
      cancelRequested: false,
      error: "Fireworks base-model deployment has no available capacity.",
      createdAt: "2026-07-21T12:00:00.000Z",
      startedAt: "2026-07-21T12:00:00.000Z",
      completedAt: "2026-07-21T12:00:02.000Z",
      updatedAt: "2026-07-21T12:00:02.000Z",
    });
    const markup = renderToStaticMarkup(
      createElement(LabModelDataset, {
        artifact: null,
        taskset,
        onOpenFiles: noop,
        training: {
          payload: { baselineRuns: [run] },
          actions: {
            datasetRows: async () => null,
            cancelBaselineRun: async () => null,
          },
        } as any,
      }),
    );

    expect(markup).toContain(">Checks<");
    expect(markup).toContain("Train signal");
    expect(markup).toContain("Current");
    expect(markup).toContain("RESOURCE_EXHAUSTED");
    expect(markup).toContain("no available capacity");
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

  test("uses the canonical profile catalog id for an Agent chat action", () => {
    const profile = {
      agents: [{
        id: "account-health-agent",
        name: "Account Health Agent",
        path: "agents/account-health-agent",
        enabled: true,
      }],
      actionCatalog: [{
        id: "chat",
        agentId: "account-health-agent",
        sourcePath: "/profile/agents/account-health-agent",
        sourceActionId: "chat",
        name: "chat",
        label: "Chat",
        description: "Answer account questions.",
        visibility: "default",
        inputSchema: "AccountHealthChatInput",
        outputSchema: "AccountHealthResponse",
        approvalPolicy: null,
        artifactPolicy: null,
        setupRequirements: [],
        mcp: null,
        schedulePolicy: null,
        trace: null,
        implementation: { type: "workflow", workflowId: "account-health-chat" },
      }],
      lastCheck: null,
    } as unknown as OpenPondProfileState;

    expect(labWorkproductProjection({ profile, training: null, runs: [] })[0])
      .toMatchObject({
        id: "account-health-agent",
        useActionId: "chat",
      });

    profile.actionCatalog[0]!.id = "account-health-agent.chat";
    expect(labWorkproductProjection({ profile, training: null, runs: [] })[0])
      .toMatchObject({ useActionId: "account-health-agent.chat" });
  });

  test("uses meaningful Agent names instead of lifecycle labels", () => {
    const objective =
      "Monitor customer account health, answer account questions with source-backed facts.";
    const draft = createImproveRunFixture({
      id: "create_improve_agent_name",
      target: {
        kind: "agent",
        id: "agent_draft_name",
        displayName: "Create agent",
        defaultActionKey: null,
      },
      objective,
    });
    const [workproduct] = labWorkproductProjection({
      profile: null,
      training: null,
      runs: [draft],
    });

    expect(workproduct?.name).toBe("Monitor customer account health · NAME");
    expect(workproduct?.name).not.toBe("Create agent");
    expect(workproduct?.description).toBe(objective);
  });

  test("gives concurrent Agent drafts distinct stable titles and replaces them with a canonical name", () => {
    const objective = "Monitor customer account health and renewal risk.";
    const draft = (id: string, state: "planning" | "failed" | "awaiting_plan_approval") =>
      createImproveRunFixture({
        id,
        state,
        target: {
          kind: "agent",
          id: null,
          displayName: "Create agent",
          defaultActionKey: null,
        },
        objective,
      });
    const drafts = [
      draft("create_agent_alpha", "planning"),
      draft("create_agent_bravo", "failed"),
      draft("create_agent_charlie", "awaiting_plan_approval"),
    ];
    const projected = labWorkproductProjection({ profile: null, training: null, runs: drafts });

    expect(new Set(projected.map((item) => item.name))).toHaveLength(3);
    expect(projected.every((item) => item.name.startsWith("Monitor customer account health"))).toBe(true);
    expect(projected.every((item) => item.name !== "Create agent")).toBe(true);

    const canonical = createImproveRunFixture({
      ...drafts[0],
      target: {
        kind: "agent",
        id: "account-health-agent",
        displayName: "Account Health Agent",
        defaultActionKey: "chat",
      },
    });
    expect(labWorkproductProjection({ profile: null, training: null, runs: [canonical] })[0]?.name)
      .toBe("Account Health Agent");
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
    ).toEqual({ kind: "resume_run", label: "Continue update" });
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
    const rftTaskset = TasksetSchema.parse({
      ...readyTaskset,
      capabilities: {
        ...readyTaskset.capabilities,
        compatibleMethods: ["grpo"],
      },
      readiness: {
        ...readyTaskset.readiness!,
        recommendedMethod: "grpo",
        trainingPath: { primaryMethod: "grpo", bootstrap: null },
        baselineReportId: null,
        baselineReward: null,
      },
    });
    expect(
      labWorkproductProgression({
        workproduct,
        runs: [],
        taskset: rftTaskset,
        training: null,
      })
    ).toMatchObject({
      statusLabel: "Test base model",
      action: { kind: "start_training", label: "Configure training" },
    });
  });

  test("keeps the Versions screen visible before the first training attempt", () => {
    const taskset = tasksetFixture({ ready: true });
    const trainingState = TrainingStateResponseSchema.parse({
      schemaVersion: "openpond.trainingState.v1",
      profileId: "default",
      sources: [],
      creations: [],
      tasksets: [taskset],
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
      generatedAt: "2026-07-20T12:00:00.000Z",
    });
    const markup = renderToStaticMarkup(
      createElement(LabModelVersionsPage, {
        workproduct: {
          key: `model:${taskset.id}`,
          kind: "model",
          id: taskset.id,
          name: "Fixture model",
          description: taskset.objective,
          status: "Ready",
          updatedAt: taskset.updatedAt,
          path: null,
          enabled: null,
          runIds: [],
          conversationId: null,
          tasksetId: taskset.id,
        },
        runs: [],
        training: {
          payload: trainingState,
          actions: {},
        } as any,
        onOpenDataset: noop,
        onOpenEntry: noop,
        onToast: noop,
      }),
    );

    expect(markup).toContain('aria-label="Versions"');
    expect(markup).toContain("<table");
    expect(markup).toContain("<th>Version</th>");
    expect(markup).toContain("No training attempts yet.");
    expect(markup).toContain("Create the first Version");
  });

  test("shows a persisted train-signal check in the Model Versions table", () => {
    const taskset = tasksetFixture({ ready: true });
    const modelId = "model_fixture_train_signal";
    const baselineRun = TasksetBaselineRunSchema.parse({
      schemaVersion: "openpond.tasksetBaselineRun.v1",
      id: "baseline_run_model_capacity",
      profileId: "default",
      targetModelId: modelId,
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      status: "failed",
      configuration: {
        split: "train",
        taskLimit: 16,
        attemptsPerTask: 8,
        selectionSeed: 17,
        selectionStrategy: "rft_easy_curriculum_v1",
        model: {
          providerId: "fireworks",
          modelId: "accounts/fireworks/models/qwen3-0p6b",
        },
        sampling: { maxOutputTokens: 2_048, temperature: 0.8, topP: 0.95 },
      },
      scope: null,
      progress: {
        stage: "provisioning",
        completedAttempts: 0,
        totalAttempts: 128,
        correctAttempts: 0,
        incorrectAttempts: 0,
        parseableAttempts: 0,
        infrastructureFailures: 0,
      },
      provider: {
        providerId: "fireworks",
        accountId: "test-account",
        deploymentId: "op-baseline-capacity",
        phase: "deleted",
        state: "DELETED",
        statusCode: "RESOURCE_EXHAUSTED",
        statusMessage: "no available capacity",
        createdAt: "2026-07-21T12:00:00.000Z",
        readyAt: null,
        releasedAt: "2026-07-21T12:00:02.000Z",
      },
      reportId: null,
      estimatedCostUsd: null,
      cancelRequested: false,
      error: "Fireworks base-model deployment has no available capacity.",
      createdAt: "2026-07-21T12:00:00.000Z",
      startedAt: "2026-07-21T12:00:00.000Z",
      completedAt: "2026-07-21T12:00:02.000Z",
      updatedAt: "2026-07-21T12:00:02.000Z",
    });
    const trainingState = TrainingStateResponseSchema.parse({
      schemaVersion: "openpond.trainingState.v1",
      profileId: "default",
      sources: [],
      creations: [],
      tasksets: [taskset],
      baselineReports: [],
      baselineRuns: [baselineRun],
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
      generatedAt: "2026-07-21T12:00:03.000Z",
    });
    const markup = renderToStaticMarkup(
      createElement(LabModelVersionsPage, {
        workproduct: {
          key: `model:${modelId}`,
          kind: "model",
          id: modelId,
          name: "Fixture model",
          description: taskset.objective,
          status: "Ready",
          updatedAt: taskset.updatedAt,
          path: null,
          enabled: null,
          runIds: [],
          conversationId: null,
          tasksetId: taskset.id,
        },
        runs: [],
        training: {
          payload: trainingState,
          actions: { cancelBaselineRun: async () => null },
        } as any,
        onOpenDataset: noop,
        onOpenEntry: noop,
        onToast: noop,
      }),
    );

    expect(markup).toContain("Train-signal check");
    expect(markup).toContain("Check failed");
    expect(markup).toContain("No attempts");
    expect(markup).toContain("model_capaci");
    expect(markup).not.toContain("No training attempts yet.");

    const detail = renderToStaticMarkup(
      createElement(LabModelVersionDetailPage, {
        connection: null,
        selectedEntryKey: `baseline:${baselineRun.id}`,
        workproduct: {
          key: `model:${modelId}`,
          kind: "model",
          id: modelId,
          name: "Fixture model",
          description: taskset.objective,
          status: "Ready",
          updatedAt: taskset.updatedAt,
          path: null,
          enabled: null,
          runIds: [],
          conversationId: null,
          tasksetId: taskset.id,
        },
        runs: [],
        training: {
          payload: trainingState,
          actions: { cancelBaselineRun: async () => null },
        } as any,
        onBack: noop,
        onOpenDataset: noop,
        onUseVersion: noop,
      }),
    );
    expect(detail).toContain("Train-signal check");
    expect(detail).toContain("RESOURCE_EXHAUSTED");
    expect(detail).toContain("no available capacity");
  });

  test("chooses only the Dataset in the first New version dialog", () => {
    const taskset = tasksetFixture({ ready: true });
    const state = TrainingStateResponseSchema.parse({
      schemaVersion: "openpond.trainingState.v1",
      profileId: "default",
      sources: [],
      creations: [],
      tasksets: [taskset],
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
      generatedAt: "2026-07-20T12:00:00.000Z",
    });
    const markup = renderToStaticMarkup(
      createElement(LabNewVersionDialog, {
        state,
        initialTasksetId: taskset.id,
        checking: false,
        onClose: noop,
        onCheck: async () => undefined,
        onContinue: noop,
        onReview: noop,
      }),
    );

    expect(markup).toContain("Choose the immutable Dataset revision.");
    expect(markup).toContain("Training setup comes next.");
    expect(markup).toContain("Configure training");
    expect(markup).not.toContain("Version training method");
    expect(markup).not.toContain(">Supervised<");
    expect(markup).not.toContain(">RFT<");
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
    const route = (
      await Promise.all([
        readFile("apps/web/src/components/labs/LabsRoute.tsx", "utf8"),
        readFile("apps/web/src/components/labs/LabsRouteSections.tsx", "utf8"),
      ])
    ).join("\n");
    const detail = (
      await Promise.all([
        readFile("apps/web/src/components/labs/LabWorkproductDetail.tsx", "utf8"),
        readFile("apps/web/src/components/labs/LabWorkproductDetailSections.tsx", "utf8"),
      ])
    ).join("\n");
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
    const app = await readFile(
      "apps/web/src/app/AppRuntimeView.tsx",
      "utf8"
    );
    const labAgentAuthoring = await readFile(
      "apps/web/src/hooks/useLabAgentAuthoring.ts",
      "utf8",
    );
    const navigation = await readFile(
      "apps/web/src/hooks/useLabDetailNavigation.ts",
      "utf8"
    );
    expect(mainPane).toContain('(view === "chat" || view === "labs")');
    expect(mainPane).toContain(
      "onOpenRunConversation={onOpenRightChatForSession}"
    );
    expect(mainPane).toContain("onCreateAgent={createAgentFromLab}");
    expect(labAgentAuthoring).toContain('systemKind: "openpond.lab"');
    expect(labAgentAuthoring).toContain("hiddenFromDefaultSidebar: true");
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
    expect(markup).toContain("Update ready");
    expect(markup).toContain("Current Agent: 0/1 checks passed");
    expect(markup).toContain("Updated Agent: 1/1 checks passed");
    expect(markup).toContain("Apply update");
    expect(markup).toContain("Keep current version");
  });

  test("renders Agent change review as request, changes, checks, and apply without internal Git details", () => {
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
    expect(markup).toContain(">Checks<");
    expect(markup).toContain(">Apply<");
    expect(markup).toContain("Files (1)");
    expect(markup).toContain("Apply update");
    expect(markup).not.toContain("Base");
    expect(markup).not.toContain("Branch");
    expect(markup).not.toContain("candidate");
    expect(markup).not.toContain("Evals");
    expect(markup).not.toContain("Review the drafted files and their Evals");
    expect(markup).not.toContain("Files changed");
    expect(markup).not.toContain("profiles/default/agent/instructions.md");
    expect(markup.indexOf(">Request<")).toBeLessThan(
      markup.indexOf(">Changes<")
    );
    expect(markup.indexOf(">Changes<")).toBeLessThan(
      markup.indexOf("Files (1)")
    );
    expect(markup.indexOf("Files (1)")).toBeLessThan(markup.indexOf(">Checks<"));
    expect(markup.indexOf(">Changes<")).toBeLessThan(markup.indexOf(">Checks<"));
    expect(markup.indexOf(">Checks<")).toBeLessThan(markup.indexOf(">Apply<"));

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
