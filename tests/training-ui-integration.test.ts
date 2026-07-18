import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { TrainingView } from "../apps/web/src/components/training/TrainingView";
import { TrainingTasksetDetail } from "../apps/web/src/components/training/TrainingTasksetDetail";
import {
  TrainingStartDialog,
  trainingRecipe,
} from "../apps/web/src/components/training/TrainingStartDialog";
import { TrainingSuggestions } from "../apps/web/src/components/training/TrainingSuggestions";
import {
  TrainingModelComparisons,
  TrainingRolloutReceipts,
} from "../apps/web/src/components/training/TrainingModelEvidence";
import { TrainingModelPromotion } from "../apps/web/src/components/training/TrainingModelPromotion";
import { trainingModelRows, trainingRunMethodLabel } from "../apps/web/src/components/training/training-model-data";
import { recommendedSequenceLength } from "../apps/web/src/components/training/training-start-defaults";
import { TasksetSchema } from "../packages/contracts/src";
import { planFixture, sourceFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("Training UI", () => {
  test("renders the Models workspace without duplicating Lab navigation", () => {
    const taskset = tasksetFixture();
    const controller = { payload: { schemaVersion: "openpond.trainingState.v1", profileId: "default", sources: [sourceFixture()], creations: [], tasksets: [taskset], baselineReports: [], candidates: [], minerConfig: { schemaVersion: "openpond.taskMinerConfig.v1", enabled: false, localOnly: true, observationWindowDays: 30, minimumRecurrence: 3, clustering: "hybrid_deterministic_first", consentRequired: true }, plans: [], bundles: [], jobs: [], artifacts: [], models: [{ id: "lineage_fixture", tasksetId: taskset.id, status: "imported", importedAt: "2026-07-12T01:00:00Z" }], destinations: [], credentialRefs: [], generatedAt: "2026-07-12T00:00:00Z" }, loading: false, busyAction: null, error: null, refresh: async () => null, actions: actionStubs() } as any;
    const html = renderToStaticMarkup(createElement(TrainingView, { training: controller, sessions: [], connection: null, defaultModel: { providerId: "custom-openai-compatible", modelId: "fixture" }, onError: () => undefined, onToast: () => 1, onSettingsPreferences: () => undefined, onOpenChat: () => undefined, onChatWithModel: () => undefined, onOpenTasksetFiles: () => undefined, selectedTasksetId: null, onSelectedTasksetIdChange: () => undefined, onSelectedTrainingJobIdChange: () => undefined, detailTasksetId: null, onDetailTasksetIdChange: () => undefined, launchRequest: null, onLaunchHandled: () => undefined, preferences: { defaultModelRef: null, creationMode: "customize", autoApproveEvidence: false }, settingsPreferences: {} as any, providerSettings: null, reasoningEffort: "high" }));
    for (const label of ["Models", "Settings"]) expect(html).toContain(label);
    expect(html).not.toContain("New model");
    expect(html).not.toContain("<h1>Training</h1>");
    expect(html).not.toContain('>Experiments<');
    expect(html).not.toContain('>Suggestions');
    expect(html).not.toContain("AI suggestions");
    expect(html).toContain('<th>Runs</th>');
    expect(html).not.toContain('aria-label="Training sections"');
    expect(html).not.toContain("Tasksets &amp; runs");
    for (const removed of ["Task Creator", "Create with defaults", "Customize", "Add chats"]) expect(html).not.toContain(removed);
    expect(html).toContain("training-models-table");
    expect(html).not.toContain("training-header-tabs");
    expect(html).not.toContain("training-section-context");
    expect(html).not.toContain("Training plans, runs, artifacts, and model handoff.");
    expect(html).toContain("> Chat</button>");
    expect(html).toContain("Fixture Taskset model");
    for (const label of ["Model", "Primary", "Latest run", "Base model", "Runs", "Updated", "Status"]) expect(html).toContain(`<th>${label}</th>`);
    expect(html).not.toContain("Materialized tasks, graders, baselines, and readiness.");
    expect(html).not.toContain('aria-label="Tasksets"');
    expect(html).not.toContain("gradient");
    expect(html).toContain("Settings");
    for (const removed of ["Check grader", "Run checks", "Baseline model", "Run baseline", ">Readiness<", ">Check<"]) expect(html).not.toContain(removed);
    expect(html).not.toContain("View code");
    expect(html).not.toContain("training-taskset-detail-shell");
    expect(html).not.toContain("training-eyebrow");
    expect(html).not.toContain(">Overview<");
    expect(html).not.toContain(">Graders<");
  });

  test("renders suggested experiments only on the dedicated Suggestions surface", () => {
    const controller = { payload: { candidates: [] }, busyAction: null, actions: actionStubs() } as any;
    const html = renderToStaticMarkup(createElement(TrainingSuggestions, {
      training: controller,
      defaultModel: { providerId: "custom-openai-compatible", modelId: "fixture" },
      preferences: { creationMode: "customize", autoApproveEvidence: false },
      reasoningEffort: "high",
      onPlanStarted: () => undefined,
    }));
    expect(html).toContain("AI suggestions");
    expect(html).toContain("No AI suggestions yet");
    expect(html).toContain("Automated");
  });

  test("shows the method and a plain evaluation preview without canned blocker copy", () => {
    const taskset = tasksetFixture();
    const controller = { payload: { tasksets: [taskset] }, busyAction: null, actions: actionStubs() } as any;
    const html = renderToStaticMarkup(createElement(TrainingTasksetDetail, { taskset, training: controller, onOpenChat: () => undefined }));
    for (const label of ["Method", "SFT", "Training examples", "Test examples", "Evaluation", "Expected output match", "2 chats"]) expect(html).toContain(label);
    expect(html).not.toContain("<h2>Fixture Taskset</h2>");
    expect(html).toContain("training-chat-link");
    expect(html).not.toContain("At least one approved training demonstration");
    expect(html).not.toContain(" · ");
  });

  test("opens the existing workspace Files sidebar at the selected Taskset folder", async () => {
    const [appModules, pane, workspace, diffPanel] = await Promise.all([
      Promise.all([
        readFile("apps/web/src/App.tsx", "utf8"),
        readFile("apps/web/src/app/useAppPrimaryRuntime.ts", "utf8"),
        readFile("apps/web/src/app/useAppSecondaryRuntime.ts", "utf8"),
        readFile("apps/web/src/app/AppRuntimeView.tsx", "utf8"),
      ]),
      readFile("apps/web/src/components/app-shell/MainPane.tsx", "utf8"),
      readFile("apps/web/src/hooks/useWorkspaceController.ts", "utf8"),
      readFile("apps/web/src/components/workspace-diff/WorkspaceDiffPanel.tsx", "utf8"),
    ]);
    const app = appModules.join("\n");
    expect(app).toContain('view === "labs"');
    expect(app).toContain('if (view === "labs")');
    expect(app).toContain('tab: "summary"');
    expect(app).toContain('showDiffControls: view === "chat" || view === "cloud"');
    expect(pane).toContain("trainingTasksetRootPath");
    expect(pane).toContain("profiles/${bootstrap?.profile.activeProfile ?? \"default\"}/tasksets/${activeTrainingTasksetId}");
    expect(pane).toContain("fileRootPath={showLabCandidateDiffPanel");
    expect(pane).toContain(": rightSidebarUsesSandbox");
    expect(pane).toContain(": trainingTasksetRootPath}");
    expect(pane).toContain("onOpenTasksetFiles: onShowFilesPanel");
    expect(pane).toContain("trainingSummary={trainingSidebarSummary}");
    expect(diffPanel).toContain("TrainingRunSidebarSummary");
    expect(diffPanel).toContain("rootPath={fileRootPath}");
    expect(workspace).toContain('view === "labs"');
  });

  test("keeps model navigation and destructive controls in the intended surfaces", async () => {
    const [detail, topBar] = await Promise.all([
      readFile("apps/web/src/components/training/TrainingModelDetail.tsx", "utf8"),
      readFile("apps/web/src/components/app-shell/AppTopBar.tsx", "utf8"),
    ]);
    for (const tab of ["Summary", "Details", "Configuration", "Settings"]) expect(detail).toContain(`>${tab}</button>`);
    expect(detail).toContain("<TrainingModelConfiguration");
    expect(detail).toContain(">Delete model</button>");
    expect(detail).not.toContain("training-back-button");
    expect(detail).not.toContain('aria-label="Model settings"');
    expect(topBar).toContain("backAction.label");
    expect(topBar).toContain("<ArrowLeft size={16}");
  });

  test("hands a newly materialized Taskset to its model Summary", async () => {
    const view = await readFile("apps/web/src/components/training/TrainingView.tsx", "utf8");
    expect(view).toContain("onSelectedTasksetIdChange(creation.materializedTasksetId)");
    expect(view).toContain("onDetailTasksetIdChange(creation.materializedTasksetId)");
    expect(view).toContain('onSectionChange?.("models")');
    expect(view).toContain("onTasksetCreated={finishTasksetCreation}");
    expect(view).not.toContain('onTasksetCreated={() => finishRunSetup("tasksets")}');
  });

  test("keeps supervised and reinforcement setup separate without relabeling RFT as local SFT", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = TasksetSchema.parse({
      ...base,
      capabilities: { ...base.capabilities, compatibleMethods: ["grpo", "sft"] },
      metadata: { ...base.metadata, trainingMethod: "grpo" },
      readiness: {
        ...base.readiness!,
        recommendedMethod: "grpo",
        trainingPath: { primaryMethod: "grpo", bootstrap: { method: "sft", purpose: "trajectory_bootstrap", demonstrationRefs: ["demo_train"], limitations: ["Bootstrap does not satisfy GRPO."] } },
      },
    });
    const html = renderToStaticMarkup(createElement(TrainingStartDialog, { connection: null, taskset, destinations: [{ schemaVersion: "openpond.trainingDestinationCapabilities.v1", destinationId: "local_cpu_fixture", available: true, methods: ["sft"], parameterizations: ["lora"], modelAllowlist: [], maxDatasetBytes: null, environmentPlacements: ["local"], nonProduction: true, unavailableReason: null, checkedAt: "2026-07-13T00:00:00.000Z" }], initialMethod: "sft", busy: false, onClose: () => undefined, onPrepare: async () => null, onConfirmPrepared: async () => false, onStart: async () => true }));
    expect(html).toContain('aria-label="Training method"');
    expect(html).toContain(">Supervised<");
    expect(html).toContain(">Reinforcement<");
    expect(html).toContain(">SFT<");
    expect(html).toContain(">RFT<");
    expect(html).toContain("Supervised precursor");
    expect(html).toContain("It does not replace reinforcement training");
    expect(html).toContain("Bootstrap does not satisfy GRPO.");
    expect(html).not.toContain("Primary · GRPO");
    expect(html).not.toContain("Precursor · SFT");
  });

  test("labels an executed SFT precursor as a bootstrap rather than a GRPO run", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = TasksetSchema.parse({
      ...base,
      capabilities: { ...base.capabilities, compatibleMethods: ["grpo", "sft"] },
      metadata: { ...base.metadata, trainingMethod: "grpo" },
      readiness: {
        ...base.readiness!,
        recommendedMethod: "grpo",
        trainingPath: {
          primaryMethod: "grpo",
          bootstrap: {
            method: "sft",
            purpose: "trajectory_bootstrap",
            demonstrationRefs: ["demo_train"],
            limitations: ["Bootstrap does not satisfy GRPO."],
          },
        },
      },
    });
    const plan = planFixture(taskset);
    const rows = trainingModelRows({
      tasksets: [taskset],
      plans: [plan],
      jobs: [],
      models: [{ id: "lineage_bootstrap", tasksetId: taskset.id, status: "imported", importedAt: "2026-07-13T00:00:00.000Z" }],
    } as any);

    expect(trainingRunMethodLabel(taskset, plan)).toBe("SFT bootstrap");
    expect(rows[0]).toMatchObject({ primaryMethod: "grpo", latestRunLabel: "SFT bootstrap" });
    expect(rows[0]?.latestRunLabel).not.toContain("GRPO");
  });

  test("defaults the sequence length to a compatible power of two for the authored examples", () => {
    const base = tasksetFixture({ ready: true });
    const longTaskset = TasksetSchema.parse({
      ...base,
      tasks: base.tasks.map((task) => task.split === "train"
        ? { ...task, input: { prompt: "p".repeat(235) }, expectedOutput: { text: "e".repeat(123) } }
        : task),
    });

    expect(recommendedSequenceLength(longTaskset)).toBe(256);
    const html = renderToStaticMarkup(createElement(TrainingStartDialog, { connection: null, taskset: longTaskset, destinations: [{ schemaVersion: "openpond.trainingDestinationCapabilities.v1", destinationId: "local_cpu_fixture", available: true, methods: ["sft"], parameterizations: ["lora"], modelAllowlist: [], maxDatasetBytes: null, environmentPlacements: ["local"], nonProduction: true, unavailableReason: null, checkedAt: "2026-07-13T00:00:00.000Z" }], busy: false, onClose: () => undefined, onPrepare: async () => null, onConfirmPrepared: async () => false, onStart: async () => true }));
    expect(html).toContain("Sequence length");
    expect(html).toContain("Learning rate");
    expect(html).toContain('value="256"');
  });

  test("shows an explicit bounded Fireworks export and spend approval", () => {
    const taskset = tasksetFixture({ ready: true });
    const html = renderToStaticMarkup(createElement(TrainingStartDialog, {
      connection: null,
      taskset,
      destinations: [{
        schemaVersion: "openpond.trainingDestinationCapabilities.v1",
        destinationId: "fireworks",
        available: true,
        methods: ["sft"],
        parameterizations: ["lora"],
        modelAllowlist: ["accounts/fireworks/models/qwen3-0p6b"],
        maxDatasetBytes: 1_000_000,
        environmentPlacements: ["provider_native"],
        nonProduction: false,
        unavailableReason: null,
        checkedAt: "2026-07-17T00:00:00.000Z",
      }],
      busy: false,
      onClose: () => undefined,
      onPrepare: async () => null,
      onConfirmPrepared: async () => false,
      onStart: async () => true,
    }));

    expect(html).toContain("Qwen3 0.6B");
    expect(html).toContain("Provider approval");
    expect(html).toContain("Maximum provider spend (USD)");
    expect(html).toContain('value="3"');
    expect(html).toContain("Prepare a provider-validated quote · hard cap $3.00");
    expect(html).toContain("Prepare exact quote");
    expect(html).toContain("Frozen Eval cases and grader secrets stay in OpenPond");
    expect(html).toContain("Approval is bound server-side to the signed-in OpenPond account");
    expect(html).toContain("Portable output imported into app-managed storage");
    expect(html).toContain("Approve the bounded train-split export");
    expect(html).toContain('disabled=""');
  });

  test("discloses the public callback gate for Fireworks RFT", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = TasksetSchema.parse({
      ...base,
      capabilities: { ...base.capabilities, compatibleMethods: ["grpo"] },
      metadata: { ...base.metadata, trainingMethod: "grpo" },
      readiness: {
        ...base.readiness!,
        recommendedMethod: "grpo",
        trainingPath: { primaryMethod: "grpo", bootstrap: null },
      },
    });
    const html = renderToStaticMarkup(createElement(TrainingStartDialog, {
      connection: null,
      taskset,
      destinations: [{
        schemaVersion: "openpond.trainingDestinationCapabilities.v1",
        destinationId: "fireworks",
        available: true,
        methods: ["sft", "grpo"],
        parameterizations: ["lora"],
        modelAllowlist: ["accounts/fireworks/models/qwen3-0p6b"],
        maxDatasetBytes: 1_000_000,
        environmentPlacements: ["provider_native"],
        nonProduction: false,
        unavailableReason: null,
        checkedAt: "2026-07-17T00:00:00.000Z",
      }],
      busy: false,
      onClose: () => undefined,
      onPrepare: async () => null,
      onConfirmPrepared: async () => false,
      onStart: async () => true,
    }));

    expect(html).toContain("RFT requires a public HTTPS callback");
    expect(html).toContain("/v1/training/fireworks/rft");
    expect(html).toContain("Launch fails closed before provider upload");
    expect(html).toContain("Prompts per update");
    expect(html).toContain('value="8"');
  });

  test("budgets every grouped RFT rollout and defaults to the supported 8B model", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = TasksetSchema.parse({
      ...base,
      tasks: [
        ...base.tasks,
        { ...base.tasks[0]!, id: "train_extra", split: "train" },
      ],
      contentHash: "taskset-ui-rft-budget-v1",
    });
    const recipe = trainingRecipe({
      method: "grpo",
      taskset,
      destinationId: "fireworks",
      baseModelId: "accounts/fireworks/models/qwen3-8b",
      maxSteps: 10,
      sequenceLength: 8_192,
      rank: 16,
      learningRate: 0.00005,
      model: null,
      rolloutGroupSize: 8,
      rolloutConcurrency: 4,
    });
    expect(recipe.method).toBe("grpo");
    if (recipe.method !== "grpo") return;
    expect(recipe.resourceLimits.maxRollouts).toBe(
      taskset.tasks.filter((task) => task.split === "train").length * 8,
    );

    const html = renderToStaticMarkup(createElement(TrainingStartDialog, {
      connection: null,
      taskset,
      destinations: [{
        schemaVersion: "openpond.trainingDestinationCapabilities.v1",
        destinationId: "fireworks",
        available: true,
        methods: ["sft", "grpo"],
        parameterizations: ["lora"],
        modelAllowlist: [
          "accounts/fireworks/models/qwen3-0p6b",
          "accounts/fireworks/models/qwen3-8b",
        ],
        maxDatasetBytes: 1_000_000,
        environmentPlacements: ["provider_native"],
        nonProduction: false,
        unavailableReason: null,
        checkedAt: "2026-07-18T00:00:00.000Z",
      }],
      busy: false,
      onClose: () => undefined,
      onPrepare: async () => null,
      onConfirmPrepared: async () => false,
      onStart: async () => true,
    }));
    expect(html).toContain("Qwen3 8B · Fireworks managed LoRA");
  });

  test("uses a full transformer LoRA target set for real SmolLM adapters", async () => {
    const dialog = await readFile("apps/web/src/components/training/TrainingStartDialog.tsx", "utf8");
    for (const module of ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]) expect(dialog).toContain(`"${module}"`);
    expect(dialog).toContain("targetModules: SMOLLM2_LORA_TARGET_MODULES");
  });

  test("keeps long New model recommendations scrollable", async () => {
    const css = await readFile("apps/web/src/styles/training/training.css", "utf8");
    expect(css).toContain(".training-run-workflow-step{height:min(680px,calc(100vh - 40px));overflow:hidden}");
    expect(css).toContain(".training-dialog-scroll-body{min-height:0;overflow:auto");
  });

  test("does not discard an unsaved model configuration when Training polling returns equivalent data", async () => {
    const configuration = await readFile("apps/web/src/components/training/TrainingModelConfiguration.tsx", "utf8");
    expect(configuration).toContain('`${lineage.id}:${lineage.chatConfiguration.updatedAt ?? "initial"}`');
    expect(configuration).toContain("}, [savedConfigurationVersion]);");
    expect(configuration).not.toContain("}, [lineage?.chatConfiguration, lineage?.id]);");
  });

  test("shows explicit promotion, method-separated comparison, rollback, and correlated rollout evidence", () => {
    const taskset = tasksetFixture({ ready: true });
    const plan = planFixture(taskset);
    const lineage = {
      id: "lineage_promotable",
      tasksetId: taskset.id,
      jobId: "training_job_promotable",
      artifactId: "artifact_promotable",
      frozenEvaluationArtifactId: "evaluation_promotable",
      promotable: true,
      status: "imported",
      importedAt: "2026-07-17T00:00:00.000Z",
    };
    const state = {
      models: [lineage],
      plans: [plan],
      jobs: [{
        id: lineage.jobId,
        planId: plan.id,
        destinationId: "fireworks",
      }],
      artifacts: [{
        id: lineage.frozenEvaluationArtifactId,
        metadata: {
          basePassRate: 0.25,
          trainedPassRate: 1,
        },
      }],
      modelBindings: [{
        id: "model_binding_active",
        status: "active",
        role: "chat_manual",
        roleTargetId: "default",
        modelArtifactLineageId: lineage.id,
        rollbackTargetBindingId: "model_binding_prior",
      }],
    } as any;
    const controller = {
      payload: state,
      busyAction: null,
      actions: actionStubs(),
    } as any;
    const promotion = renderToStaticMarkup(createElement(TrainingModelPromotion, {
      lineage: lineage as any,
      state,
      training: controller,
      onToast: () => 1,
    }));
    expect(promotion).toContain("Promotion gate");
    expect(promotion).toContain("Passed");
    expect(promotion).toContain("Default chat model");
    expect(promotion).toContain(">Roll back</button>");
    expect(promotion).toContain("<strong>prior</strong>");

    const comparison = renderToStaticMarkup(createElement(TrainingModelComparisons, {
      taskset,
      state,
    }));
    expect(comparison).toContain("Base model");
    expect(comparison).toContain("Latest candidate");
    expect(comparison).toContain("SFT");
    expect(comparison).toContain("100% (+75 pts)");
    expect(comparison).toContain("chat_manual:default");

    const currentPlan = {
      ...plan,
      id: "training_plan_current_rft",
      createdAt: "2026-07-18T01:00:00.000Z",
      recipe: {
        ...plan.recipe,
        baseModel: {
          ...plan.recipe.baseModel,
          id: "accounts/fireworks/models/qwen3-8b",
        },
      },
    };
    const currentComparison = renderToStaticMarkup(createElement(
      TrainingModelComparisons,
      {
        taskset,
        state: {
          ...state,
          plans: [plan, currentPlan],
          jobs: [
            {
              ...state.jobs[0],
              createdAt: "2026-07-17T00:00:00.000Z",
              updatedAt: "2026-07-17T00:00:00.000Z",
            },
            {
              id: "training_job_current_rft",
              planId: currentPlan.id,
              destinationId: "fireworks",
              status: "running",
              createdAt: "2026-07-18T01:00:00.000Z",
              updatedAt: "2026-07-18T01:01:00.000Z",
            },
          ],
        } as any,
      },
    ));
    expect(currentComparison).toContain("accounts/fireworks/models/qwen3-8b");
    expect(currentComparison).toContain("Pending for active run");

    const infrastructureBlocked = renderToStaticMarkup(createElement(
      TrainingModelComparisons,
      {
        taskset,
        state: {
          ...state,
          artifacts: [{
            id: lineage.frozenEvaluationArtifactId,
            metadata: {
              evaluationComplete: false,
              infrastructureFailureCount: 2,
              basePassRate: 0,
              trainedPassRate: 0,
            },
          }],
        } as any,
      },
    ));
    expect(infrastructureBlocked).toContain("Infrastructure blocked");
    expect(infrastructureBlocked).not.toContain("0% (+0 pts)");
    const blockedPromotion = renderToStaticMarkup(createElement(
      TrainingModelPromotion,
      {
        lineage: { ...lineage, promotable: false } as any,
        state: {
          ...state,
          models: [{ ...lineage, promotable: false }],
          artifacts: [{
            id: lineage.frozenEvaluationArtifactId,
            metadata: {
              evaluationComplete: false,
              infrastructureFailureCount: 2,
            },
          }],
        } as any,
        training: controller,
        onToast: () => 1,
      },
    ));
    expect(blockedPromotion).toContain("Run evaluation");
    expect(blockedPromotion).toContain(
      "recorded no quality result",
    );

    const receipts = renderToStaticMarkup(createElement(TrainingRolloutReceipts, {
      receipts: [{
        id: "receipt_1",
        status: "succeeded",
        taskId: "task_train",
        correlationId: "fireworks:experiment:rollout",
        providerTrace: {
          invocationId: "invocation_1",
          experimentId: "experiment_1",
          rolloutId: "rollout_1",
          runId: "run_1",
          rowId: "task_train",
        },
        policy: {
          modelId: "accounts/fireworks/models/qwen3-0p6b",
          checkpointId: "checkpoint_1",
        },
        environment: {
          id: "cross-system-operations",
          version: "cross-system-operations.v1",
          worldId: "world_1",
          worldHash: "worldhash00000000",
        },
        reward: {
          eligible: true,
          raw: 1.1,
          components: { exactAnswer: 1 },
        },
        verifier: { outcome: "correct" },
        failureClass: null,
      }] as any,
    }));
    expect(receipts).toContain("1.100");
    expect(receipts).toContain("fireworks:experiment:rollout");
    expect(receipts).toContain("checkpoint_1");
    expect(receipts).toContain("exactAnswer");

    const receiptSeed = {
      id: "receipt_seed",
      status: "succeeded",
      taskId: "task_train",
      correlationId: "fireworks:experiment:rollout",
      providerTrace: {
        invocationId: "invocation_seed",
        experimentId: "experiment_1",
        rolloutId: "rollout_seed",
        runId: "run_1",
        rowId: "task_train",
      },
      policy: {
        modelId: "accounts/fireworks/models/qwen3-8b",
        checkpointId: "checkpoint_1",
      },
      environment: {
        id: "cross-system-operations",
        version: "cross-system-operations.v1",
        worldId: "world_1",
        worldHash: "worldhash00000000",
      },
      reward: {
        eligible: true,
        raw: 0.5,
        components: {},
      },
      verifier: { outcome: "incorrect" },
      failureClass: null,
    };
    const boundedReceipts = renderToStaticMarkup(createElement(
      TrainingRolloutReceipts,
      {
        receipts: Array.from({ length: 25 }, (_, index) => ({
          ...receiptSeed,
          id: `receipt_${index}`,
          updatedAt: `2026-07-18T01:${String(index).padStart(2, "0")}:00.000Z`,
          providerTrace: {
            ...receiptSeed.providerTrace,
            rolloutId: `rollout_${String(index).padStart(2, "0")}`,
          },
        })) as any,
      },
    ));
    expect(boundedReceipts).toContain("Showing latest 24 of 25 receipts");
    expect(boundedReceipts).toContain("Show all 25");
    expect(boundedReceipts).toContain("rollout_24");
    expect(boundedReceipts).not.toContain("rollout_00");
  });
});

function actionStubs() { return new Proxy({}, { get: () => async () => null }); }
