import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import {
  defaultRftLossMethod,
  preserveBaseModelSelection,
  TrainingStartDialog,
  trainingRecipe,
} from "../apps/web/src/components/training/TrainingStartDialog";
import { TrainingSuggestions } from "../apps/web/src/components/training/TrainingSuggestions";
import {
  TrainingModelComparisons,
  TrainingRolloutReceipts,
} from "../apps/web/src/components/training/TrainingModelEvidence";
import { TrainingModelPromotion } from "../apps/web/src/components/training/TrainingModelPromotion";
import {
  trainingModelRows,
  trainingRunMethodLabel,
} from "../apps/web/src/components/training/training-model-data";
import { recommendedSequenceLength } from "../apps/web/src/components/training/training-start-defaults";
import { TasksetSchema } from "../packages/contracts/src";
import {
  planFixture,
  tasksetFixture,
} from "./helpers/training-fixtures";

describe("Training UI", () => {
  test("renders suggested experiments only on the dedicated Suggestions surface", () => {
    const controller = {
      payload: { candidates: [] },
      busyAction: null,
      actions: actionStubs(),
    } as any;
    const html = renderToStaticMarkup(
      createElement(TrainingSuggestions, {
        training: controller,
        defaultModel: {
          providerId: "custom-openai-compatible",
          modelId: "fixture",
        },
        preferences: { creationMode: "customize", autoApproveEvidence: false },
        reasoningEffort: "high",
        onPlanStarted: () => undefined,
      })
    );
    expect(html).toContain("AI suggestions");
    expect(html).toContain("No AI suggestions yet");
    expect(html).toContain("Automatic");
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
      readFile(
        "apps/web/src/components/workspace-diff/WorkspaceDiffPanel.tsx",
        "utf8"
      ),
    ]);
    const app = appModules.join("\n");
    expect(app).toContain('view === "labs"');
    expect(app).toContain('if (view === "labs")');
    expect(app).toContain('tab: "summary"');
    expect(app).toContain(
      'showDiffControls: view === "chat" || view === "cloud"'
    );
    expect(pane).toContain("trainingTasksetRootPath");
    expect(pane).toContain(
      'profiles/${bootstrap?.profile.activeProfile ?? "default"}/tasksets/${activeTrainingTasksetId}'
    );
    expect(pane).toContain("fileRootPath={showLabCandidateDiffPanel");
    expect(pane).toContain(": rightSidebarUsesSandbox");
    expect(pane).toContain(": trainingTasksetRootPath}");
    expect(pane).toContain("onOpenTasksetFiles: onShowFilesPanel");
    expect(pane).toContain("trainingSummary={trainingSidebarSummary}");
    expect(diffPanel).toContain("TrainingRunSidebarSummary");
    expect(diffPanel).toContain("rootPath={fileRootPath}");
    expect(workspace).toContain('view === "labs"');
  });

  test("opens the Model run editor from a Dataset with its immutable revision selected", async () => {
    const [
      datasets,
      route,
      builder,
      setup,
      header,
      builderHelpers,
      previews,
      pane,
      css,
    ] =
      await Promise.all([
      readFile("apps/web/src/components/labs/LabDatasetsPage.tsx", "utf8"),
      readFile("apps/web/src/components/labs/LabsRoute.tsx", "utf8"),
      readFile("apps/web/src/components/labs/ModelRunEditorPage.tsx", "utf8"),
      readFile("apps/web/src/components/labs/ModelRunSetupContent.tsx", "utf8"),
      readFile("apps/web/src/components/labs/ModelRunEditorHeader.tsx", "utf8"),
      readFile(
        "apps/web/src/components/labs/model-run-editor-helpers.ts",
        "utf8"
      ),
      readFile("apps/web/src/components/labs/ModelRunSetupPreviews.tsx", "utf8"),
      readFile("apps/web/src/components/app-shell/MainPane.tsx", "utf8"),
      readFile("apps/web/src/styles/training/training.css", "utf8"),
      ]);
    expect(datasets).toContain("Train Model");
    expect(datasets).toContain("onTrainModel(selected.id)");
    expect(route).toContain(
      "initialTasksetId={training.launchRequest.initialTasksetId}"
    );
    expect(pane).toContain("initialTasksetId,");
    expect(builder).toContain("revision: taskset.revision");
    expect(builder).toContain("contentHash: taskset.contentHash");
    expect(builder).not.toContain(">Model Builder<");
    expect(builder).toContain('aria-label="Run setup"');
    expect(setup).toContain("What do you want to build?");
    expect(builder).toContain('aria-label="Model creation"');
    expect(builder).toContain('["setup", "Setup"]');
    expect(builder).toContain('["overview", "Overview"]');
    expect(builder).toContain('["runs", "Runs"]');
    expect(builder).toContain('["configuration", "Configuration"]');
    expect(builder).not.toContain("selectedContent={datasetGoalContent}");
    expect(setup).toContain("<ModelSetupSteps");
    expect(setup).toContain('activeStep === "dataset"');
    expect(setup).toContain('activeStep === "method"');
    expect(setup).toContain('aria-label="Taskset revision"');
    expect(setup).toContain("Build a Taskset");
    expect(setup).not.toContain("Choose existing Taskset");
    expect(setup).toContain('onStepChange("dataset")');
    expect(builder).toContain('setActiveSetupStep("method")');
    expect(setup).toContain('onStepChange("configuration")');
    expect(setup).toContain('approvalPresentation="dialog"');
    expect(setup).toContain("hideMethodTabs");
    expect(setup).toContain("configurationContent={");
    expect(setup).toContain('aria-label="Training budget"');
    expect(setup).toContain('runPreset: "standard"');
    expect(setup).toContain("<h2>Choose a model</h2>");
    expect(builder).toContain("method: current.method ?? configuration.method");
    expect(builder).not.toContain("Training target · LLM weights");
    expect(builder).not.toContain("RLHF and RLVR are guidance labels");
    expect(builder).not.toContain('"Unsaved"');
    expect(header).toMatch(/>\s*Save\s*</);
    expect(header).not.toContain("Save draft");
    expect(builder).toContain("onNameChange?.(project.name)");
    expect(builder).toContain("nextModelName(state?.modelProjects ?? [])");
    expect(header).toContain("model-build-name-button");
    expect(header).toContain("setEditingName(true)");
    expect(builder).not.toContain("window.confirm");
    expect(builder).toContain("<ConfirmDialog");
    expect(builder).not.toContain("model-build-readiness");
    expect(setup).toContain("disabled={!candidate.available}");
    expect(builderHelpers).toContain("Incompatible Taskset");
    expect(builderHelpers).toContain(
      "taskset.capabilities.compatibleMethods.includes(method)"
    );
    expect(builderHelpers).toContain(
      "methodExecutionTargets(method, destinations)"
    );
    expect(builderHelpers).toContain('"Local CPU · Experimental"');
    expect(builderHelpers).toContain(
      'method === "grpo" ? "Fireworks RFT" : "Fireworks"'
    );
    expect(setup).toContain("model-build-target-pill unavailable");
    expect(builderHelpers).toContain(
      "does not execute ${method.toUpperCase()}."
    );
    expect(builder).toContain('datasetMode: "build"');
    expect(builder).toContain("renderDatasetBuilder(");
    expect(builder).toContain("(tasksetId) => {");
    expect(route).toContain("onUseExistingDataset={onUseExistingDataset}");
    expect(css).toContain(
      ".model-build-choice.selected,.model-build-method.selected{border-color:var(--border);box-shadow:none;background:transparent}"
    );
    expect(css).toContain(
      ".model-build-section{display:flex;flex-direction:column;gap:14px;padding:12px 0 20px;background:transparent}"
    );
    expect(css).toContain(
      ".model-setup-step-list{display:grid;grid-template-columns:repeat(4,minmax(110px,1fr))"
    );
    expect(css).toContain(
      ".model-setup-step-segment{display:block;width:100%;height:7px;border:0"
    );
    expect(builder).toContain("<ModelSetupRunsPreview");
    expect(previews).toContain('aria-label="Preview run"');
    expect(previews).toContain("{draft.title} · Pending");
    expect(previews).toContain('aria-label="Run detail preview"');
    expect(previews).toContain("<EmptyMetricChart");
    expect(previews).toContain("Metrics will appear after the run starts");
    expect(previews).toContain("model-setup-configuration-fields");
    expect(previews).not.toContain("Every launch will appear here");
    expect(css).toContain(".model-setup-empty-chart");
  });

  test("keeps supervised and reinforcement setup separate without relabeling RFT as local SFT", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = TasksetSchema.parse({
      ...base,
      capabilities: {
        ...base.capabilities,
        compatibleMethods: ["grpo", "sft"],
      },
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
    const html = renderToStaticMarkup(
      createElement(TrainingStartDialog, {
        baseModelCandidates: [localFixtureCandidate()],
        connection: null,
        taskset,
        destinations: [
          {
            schemaVersion: "openpond.trainingDestinationCapabilities.v1",
            destinationId: "local_cpu_fixture",
            available: true,
            methods: ["sft"],
            parameterizations: ["lora"],
            modelAllowlist: [],
            maxDatasetBytes: null,
            environmentPlacements: ["local"],
            nonProduction: true,
            unavailableReason: null,
            checkedAt: "2026-07-13T00:00:00.000Z",
          },
        ],
        initialMethod: "sft",
        busy: false,
        onClose: () => undefined,
        onPrepare: async () => null,
        onConfirmPrepared: async () => false,
        onStart: async () => true,
      })
    );
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
      capabilities: {
        ...base.capabilities,
        compatibleMethods: ["grpo", "sft"],
      },
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
      models: [
        {
          id: "lineage_bootstrap",
          tasksetId: taskset.id,
          status: "imported",
          importedAt: "2026-07-13T00:00:00.000Z",
        },
      ],
    } as any);

    expect(trainingRunMethodLabel(taskset, plan)).toBe("SFT bootstrap");
    expect(rows[0]).toMatchObject({
      primaryMethod: "grpo",
      latestRunLabel: "SFT bootstrap",
    });
    expect(rows[0]?.latestRunLabel).not.toContain("GRPO");
  });

  test("defaults the sequence length to a compatible power of two for the authored examples", () => {
    const base = tasksetFixture({ ready: true });
    const longTaskset = TasksetSchema.parse({
      ...base,
      tasks: base.tasks.map((task) =>
        task.split === "train"
          ? {
              ...task,
              input: { prompt: "p".repeat(235) },
              expectedOutput: { text: "e".repeat(123) },
            }
          : task
      ),
    });

    expect(recommendedSequenceLength(longTaskset)).toBe(256);
    const html = renderToStaticMarkup(
      createElement(TrainingStartDialog, {
        baseModelCandidates: [localFixtureCandidate()],
        connection: null,
        taskset: longTaskset,
        destinations: [
          {
            schemaVersion: "openpond.trainingDestinationCapabilities.v1",
            destinationId: "local_cpu_fixture",
            available: true,
            methods: ["sft"],
            parameterizations: ["lora"],
            modelAllowlist: [],
            maxDatasetBytes: null,
            environmentPlacements: ["local"],
            nonProduction: true,
            unavailableReason: null,
            checkedAt: "2026-07-13T00:00:00.000Z",
          },
        ],
        busy: false,
        onClose: () => undefined,
        onPrepare: async () => null,
        onConfirmPrepared: async () => false,
        onStart: async () => true,
      })
    );
    expect(html).toContain("Sequence length");
    expect(html).toContain("Learning rate");
    expect(html).toContain('value="256"');
  });

  test("does not invent provider approval policy while the server catalog loads", () => {
    const taskset = tasksetFixture({ ready: true });
    const html = renderToStaticMarkup(
      createElement(TrainingStartDialog, {
        baseModelCandidates: [
          managedCandidate("accounts/fireworks/models/qwen3-0p6b", ["sft"]),
        ],
        connection: null,
        taskset,
        destinations: [
          {
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
          },
        ],
        busy: false,
        onClose: () => undefined,
        onOpenProviderSettings: () => undefined,
        onPrepare: async () => null,
        onConfirmPrepared: async () => false,
        onStart: async () => true,
      })
    );

    expect(html).toContain("Qwen3 0.6B");
    expect(html).toContain("Loading compute catalog");
    expect(html).not.toContain("Maximum provider spend (USD)");
    expect(html).not.toContain("Prepare exact quote");
  });

  test("does not embed provider callback policy in the loading-state UI", () => {
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
    const html = renderToStaticMarkup(
      createElement(TrainingStartDialog, {
        baseModelCandidates: [
          managedCandidate("accounts/fireworks/models/qwen3-0p6b", [
            "sft",
            "grpo",
          ]),
        ],
        connection: null,
        taskset,
        destinations: [
          {
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
          },
        ],
        busy: false,
        onClose: () => undefined,
        onPrepare: async () => null,
        onConfirmPrepared: async () => false,
        onStart: async () => true,
        onOpenProviderSettings: () => undefined,
        onRunBaseline: async () => true,
      })
    );

    expect(html).toContain("Loading compute catalog");
    expect(html).not.toContain("/v1/training/fireworks/rft");
    expect(html).toContain("Optimizer steps");
    expect(html).toContain("Training examples");
    expect(html).toContain('value="8"');
    expect(html).toContain('aria-label="RL loss"');
    expect(html).not.toContain("grouped loss");
  });

  test("defaults artifact-backed RFT to the bounded train-signal canary", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = TasksetSchema.parse({
      ...base,
      tasks: [],
      datasetArtifact: {
        schemaVersion: "openpond.datasetArtifact.v1",
        id: "dataset_artifact_ui_rft",
        tasksetId: base.id,
        tasksetRevision: 1,
        contentHash: "artifacthash-ui-rft",
        format: "parquet",
        schema: {
          schemaVersion: "openpond.datasetSemanticSchema.v1",
          fields: [
            {
              name: "expected_output",
              semanticRole: "expected_output",
              logicalType: "string",
              nullable: false,
              policy: "privileged",
            },
          ],
          schemaHash: "schemahash-ui-rft",
        },
        shards: [
          {
            id: "dataset_shard_ui_rft",
            split: "train",
            path: "data/train.parquet",
            contentHash: "shardhash-ui-rft",
            schemaHash: "schemahash-ui-rft",
            sizeBytes: 1_000,
            rowCount: 100,
            rowGroupCount: 1,
          },
        ],
        rowCount: 120,
        splitCounts: { train: 100, validation: 10, test: 0, frozen_eval: 10 },
        sourceReceiptRefs: ["receipt_ui_rft"],
        mappingHash: "mappinghash-ui-rft",
        qualityReportHash: "qualityhash-ui-rft",
        createdAt: "2026-07-20T00:00:00.000Z",
      },
      capabilities: { ...base.capabilities, compatibleMethods: ["grpo"] },
      metadata: { ...base.metadata, trainingMethod: "grpo" },
      readiness: {
        ...base.readiness!,
        recommendedMethod: "grpo",
        trainingPath: { primaryMethod: "grpo", bootstrap: null },
      },
    });
    const html = renderToStaticMarkup(
      createElement(TrainingStartDialog, {
        baseModelCandidates: [
          managedCandidate("accounts/fireworks/models/qwen3-0p6b", ["grpo"]),
        ],
        connection: null,
        taskset,
        destinations: [
          {
            schemaVersion: "openpond.trainingDestinationCapabilities.v1",
            destinationId: "fireworks",
            available: true,
            methods: ["grpo"],
            parameterizations: ["lora"],
            modelAllowlist: ["accounts/fireworks/models/qwen3-0p6b"],
            maxDatasetBytes: 1_000_000,
            environmentPlacements: ["provider_native"],
            nonProduction: false,
            unavailableReason: null,
            checkedAt: "2026-07-20T00:00:00.000Z",
          },
        ],
        busy: false,
        onClose: () => undefined,
        onPrepare: async () => null,
        onConfirmPrepared: async () => false,
        onStart: async () => true,
        onRunBaseline: async () => true,
      })
    );

    expect(html).toContain("Loading compute catalog");
    expect(html).toContain('value="16"');
    expect(html).toContain("Maximum output");
    expect(html).not.toContain("grouped loss");

    const recipe = trainingRecipe({
      method: "grpo",
      taskset,
      destinationId: "fireworks",
      baseModelId: "accounts/fireworks/models/qwen3-0p6b",
      maxSteps: 8,
      sequenceLength: 2_048,
      rank: 8,
      learningRate: 0.0002,
      model: null,
      rolloutGroupSize: 8,
      rolloutConcurrency: 4,
      rolloutMaxOutputTokens: 2_048,
      trainingExamples: 16,
      executionMode: "provider_native",
    });
    expect(recipe.method === "grpo" && recipe.dataset.selectionStrategy).toBe(
      "rft_easy_curriculum_v1"
    );
    expect(recipe.method === "grpo" && recipe.resourceLimits.maxRollouts).toBe(
      128
    );
    expect(recipe.method === "grpo" && recipe.rollout.maxOutputTokens).toBe(
      2_048
    );
  });

  test("budgets every grouped provider-native RFT rollout without a client model default", () => {
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
      rolloutMaxOutputTokens: 2_048,
      trainingExamples: 2,
      executionMode: "provider_native",
    });
    expect(recipe.method).toBe("grpo");
    if (recipe.method !== "grpo") return;
    expect(recipe.resourceLimits.maxRollouts).toBe(2 * 8);
    expect(recipe.dataset.maxExamples).toBe(2);
    expect(recipe.loss.method).toBe("grpo");

    const html = renderToStaticMarkup(
      createElement(TrainingStartDialog, {
        baseModelCandidates: [
          managedCandidate("accounts/fireworks/models/qwen3-0p6b", [
            "sft",
            "grpo",
          ]),
          managedCandidate("accounts/fireworks/models/qwen3-8b", [
            "sft",
            "grpo",
          ]),
        ],
        connection: null,
        taskset,
        destinations: [
          {
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
          },
        ],
        busy: false,
        onClose: () => undefined,
        onPrepare: async () => null,
        onConfirmPrepared: async () => false,
        onStart: async () => true,
      })
    );
    expect(html).toContain("Qwen3 0.6B");
    expect(html).toContain("Qwen3 8B");
  });

  test("defaults DAPO-Math artifacts to the DAPO provider loss", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = TasksetSchema.parse({
      ...base,
      sourceRefs: base.sourceRefs.map((source, index) =>
        index === 0 ? { ...source, title: "DAPO-Math-17k" } : source
      ),
      contentHash: "taskset-ui-dapo-loss-v1",
    });
    expect(defaultRftLossMethod(taskset)).toBe("dapo");
    const recipe = trainingRecipe({
      method: "grpo",
      taskset,
      destinationId: "fireworks",
      baseModelId: "accounts/fireworks/models/qwen3-0p6b",
      maxSteps: 10,
      sequenceLength: 8_192,
      rank: 8,
      learningRate: 0.00005,
      model: null,
      rolloutGroupSize: 8,
      rolloutConcurrency: 4,
      rolloutMaxOutputTokens: 4_096,
      trainingExamples: 256,
      executionMode: "provider_native",
    });
    expect(recipe.method).toBe("grpo");
    if (recipe.method === "grpo") expect(recipe.loss.method).toBe("dapo");
  });

  test("preserves a compatible base model and clears an incompatible destination change", () => {
    const candidate = managedCandidate("accounts/fireworks/models/qwen3-8b", [
      "sft",
      "grpo",
    ]);
    expect(
      preserveBaseModelSelection(
        [candidate],
        candidate.selectionKey,
        "fireworks",
        "grpo"
      )
    ).toBe(candidate.selectionKey);
    expect(
      preserveBaseModelSelection(
        [candidate],
        candidate.selectionKey,
        "local_cpu_fixture",
        "sft"
      )
    ).toBe("");
  });

  test("uses a full transformer LoRA target set for real SmolLM adapters", async () => {
    const recipeBuilder = await readFile(
      "apps/web/src/components/training/training-start-recipe.ts",
      "utf8"
    );
    for (const module of [
      "q_proj",
      "k_proj",
      "v_proj",
      "o_proj",
      "gate_proj",
      "up_proj",
      "down_proj",
    ])
      expect(recipeBuilder).toContain(`"${module}"`);
    expect(recipeBuilder).toContain(
      "targetModules: SMOLLM2_LORA_TARGET_MODULES"
    );
  });

  test("chooses compute before narrowing the base model and device", async () => {
    const dialog = await readFile(
      "apps/web/src/components/training/TrainingCatalogSetup.tsx",
      "utf8"
    );
    const fields = dialog.slice(dialog.indexOf('<div className="training-start-fields">'));
    expect(fields.indexOf("<span>Compute</span>")).toBeLessThan(
      fields.indexOf("<span>Base model</span>")
    );
    expect(fields.indexOf("<span>Base model</span>")).toBeLessThan(
      fields.indexOf("<span>Device</span>")
    );
  });

  test("keeps long New model recommendations scrollable", async () => {
    const css = await readFile(
      "apps/web/src/styles/training/training.css",
      "utf8"
    );
    expect(css).toContain(
      ".training-run-workflow-step{height:min(680px,calc(100vh - 40px));overflow:hidden}"
    );
    expect(css).toContain(
      ".training-dialog-scroll-body{min-height:0;overflow:auto"
    );
  });

  test("replaces Chromium's amber objective-field ring with the app focus color", async () => {
    const css = await readFile(
      "apps/web/src/styles/training/training.css",
      "utf8"
    );
    expect(css).toContain(
      ".training-objective-field textarea:focus-visible{border-color:color-mix(in srgb,var(--cyan) 70%,var(--border))}"
    );
    expect(css).toContain(
      "border-radius:6px;outline:0;background:var(--panel)"
    );
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
      jobs: [
        {
          id: lineage.jobId,
          planId: plan.id,
          destinationId: "fireworks",
        },
      ],
      artifacts: [
        {
          id: lineage.frozenEvaluationArtifactId,
          metadata: {
            basePassRate: 0.25,
            trainedPassRate: 1,
          },
        },
      ],
      modelBindings: [
        {
          id: "model_binding_active",
          status: "active",
          role: "chat_manual",
          roleTargetId: "default",
          modelArtifactLineageId: lineage.id,
          rollbackTargetBindingId: "model_binding_prior",
        },
      ],
    } as any;
    const controller = {
      payload: state,
      busyAction: null,
      actions: actionStubs(),
    } as any;
    const promotion = renderToStaticMarkup(
      createElement(TrainingModelPromotion, {
        lineage: lineage as any,
        state,
        training: controller,
        onToast: () => 1,
      })
    );
    expect(promotion).toContain("Promotion gate");
    expect(promotion).toContain("Passed");
    expect(promotion).toContain("Default chat model");
    expect(promotion).toContain(">Roll back</button>");
    expect(promotion).toContain("<strong>prior</strong>");

    const comparison = renderToStaticMarkup(
      createElement(TrainingModelComparisons, {
        taskset,
        state,
      })
    );
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
    const currentComparison = renderToStaticMarkup(
      createElement(TrainingModelComparisons, {
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
      })
    );
    expect(currentComparison).toContain("accounts/fireworks/models/qwen3-8b");
    expect(currentComparison).toContain("Pending for active run");

    const infrastructureBlocked = renderToStaticMarkup(
      createElement(TrainingModelComparisons, {
        taskset,
        state: {
          ...state,
          artifacts: [
            {
              id: lineage.frozenEvaluationArtifactId,
              metadata: {
                evaluationComplete: false,
                infrastructureFailureCount: 2,
                basePassRate: 0,
                trainedPassRate: 0,
              },
            },
          ],
        } as any,
      })
    );
    expect(infrastructureBlocked).toContain("Infrastructure blocked");
    expect(infrastructureBlocked).not.toContain("0% (+0 pts)");
    const blockedPromotion = renderToStaticMarkup(
      createElement(TrainingModelPromotion, {
        lineage: { ...lineage, promotable: false } as any,
        state: {
          ...state,
          models: [{ ...lineage, promotable: false }],
          artifacts: [
            {
              id: lineage.frozenEvaluationArtifactId,
              metadata: {
                evaluationComplete: false,
                infrastructureFailureCount: 2,
              },
            },
          ],
        } as any,
        training: controller,
        onToast: () => 1,
      })
    );
    expect(blockedPromotion).toContain("Run evaluation");
    expect(blockedPromotion).toContain("recorded no quality result");

    const receipts = renderToStaticMarkup(
      createElement(TrainingRolloutReceipts, {
        receipts: [
          {
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
          },
        ] as any,
      })
    );
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
    const boundedReceipts = renderToStaticMarkup(
      createElement(TrainingRolloutReceipts, {
        receipts: Array.from({ length: 25 }, (_, index) => ({
          ...receiptSeed,
          id: `receipt_${index}`,
          updatedAt: `2026-07-18T01:${String(index).padStart(2, "0")}:00.000Z`,
          providerTrace: {
            ...receiptSeed.providerTrace,
            rolloutId: `rollout_${String(index).padStart(2, "0")}`,
          },
        })) as any,
      })
    );
    expect(boundedReceipts).toContain("Showing latest 24 of 25 receipts");
    expect(boundedReceipts).toContain("Show all 25");
    expect(boundedReceipts).toContain("rollout_24");
    expect(boundedReceipts).not.toContain("rollout_00");
  });
});

function localFixtureCandidate() {
  return {
    schemaVersion: "openpond.baseModelCandidate.v1" as const,
    selectionKey: "local_fixture",
    label: "Tiny CPU correctness fixture",
    sourceLabel: "This machine",
    preference: {
      schemaVersion: "openpond.baseModelPreference.v1" as const,
      modelId: "openpond/tiny-cpu-gpt2-fixture",
      revision: "architecture-v2-seed-17-context-512",
      tokenizerRevision: "wordlevel-v1",
      chatTemplateHash: "fixture00000000",
      modelAssetId: null,
      source: "builtin" as const,
    },
    available: true,
    nonProduction: true,
    unavailableReason: null,
    methods: ["sft" as const],
    executionOptions: [
      {
        destinationId: "local_cpu_fixture" as const,
        available: true,
        methods: ["sft" as const],
        parameterizations: ["lora" as const],
        nonProduction: true,
        unavailableReason: null,
      },
    ],
  };
}

function managedCandidate(modelId: string, methods: Array<"sft" | "grpo">) {
  return {
    schemaVersion: "openpond.baseModelCandidate.v1" as const,
    selectionKey: `managed_${modelId}`,
    label: modelId.includes("0p6b") ? "Qwen3 0.6B" : "Qwen3 8B",
    sourceLabel: "Fireworks",
    preference: {
      schemaVersion: "openpond.baseModelPreference.v1" as const,
      modelId,
      revision: null,
      tokenizerRevision: null,
      chatTemplateHash: null,
      modelAssetId: null,
      source: "managed" as const,
    },
    available: true,
    nonProduction: false,
    unavailableReason: null,
    methods,
    executionOptions: [
      {
        destinationId: "fireworks" as const,
        available: true,
        methods,
        parameterizations: ["lora" as const],
        nonProduction: false,
        unavailableReason: null,
      },
    ],
  };
}

function actionStubs() {
  return new Proxy({}, { get: () => async () => null });
}
