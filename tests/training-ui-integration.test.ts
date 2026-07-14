import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { TrainingView } from "../apps/web/src/components/training/TrainingView";
import { TrainingTasksetDetail } from "../apps/web/src/components/training/TrainingTasksetDetail";
import { TrainingStartDialog } from "../apps/web/src/components/training/TrainingStartDialog";
import { TasksetSchema } from "../packages/contracts/src";
import { sourceFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("Training UI", () => {
  test("centers training around Models and Tasksets", () => {
    const taskset = tasksetFixture();
    const controller = { payload: { schemaVersion: "openpond.trainingState.v1", profileId: "default", sources: [sourceFixture()], creations: [], tasksets: [taskset], baselineReports: [], candidates: [], minerConfig: { schemaVersion: "openpond.taskMinerConfig.v1", enabled: false, localOnly: true, observationWindowDays: 30, minimumRecurrence: 3, clustering: "hybrid_deterministic_first", consentRequired: true }, plans: [], bundles: [], jobs: [], artifacts: [], models: [{ id: "lineage_fixture", tasksetId: taskset.id, status: "imported", importedAt: "2026-07-12T01:00:00Z" }], destinations: [], credentialRefs: [], generatedAt: "2026-07-12T00:00:00Z" }, loading: false, busyAction: null, error: null, refresh: async () => null, actions: actionStubs() } as any;
    const html = renderToStaticMarkup(createElement(TrainingView, { training: controller, sessions: [], connection: null, defaultModel: { providerId: "custom-openai-compatible", modelId: "fixture" }, onError: () => undefined, onToast: () => 1, onSettingsPreferences: () => undefined, onOpenChat: () => undefined, onChatWithModel: () => undefined, onOpenTasksetFiles: () => undefined, selectedTasksetId: null, onSelectedTasksetIdChange: () => undefined, onSelectedTrainingJobIdChange: () => undefined, detailTasksetId: null, onDetailTasksetIdChange: () => undefined, launchRequest: null, onLaunchHandled: () => undefined, preferences: { defaultModelRef: null, creationMode: "customize", autoApproveEvidence: false }, settingsPreferences: {} as any, providerSettings: null, reasoningEffort: "high" }));
    for (const label of ["Models", "Tasksets", "New model", "Settings"]) expect(html).toContain(label);
    expect(html).not.toContain("<h1>Training</h1>");
    expect(html).not.toContain('>Experiments<');
    expect(html).not.toContain('>Suggestions<');
    expect(html).toContain('<th>Runs</th>');
    expect(html).toContain('aria-selected="true" class="active">Models');
    expect(html).not.toContain("Tasksets &amp; runs");
    for (const removed of ["Task Creator", "Create with defaults", "Customize", "Add chats"]) expect(html).not.toContain(removed);
    expect(html).toContain("training-models-table");
    expect(html).toContain("training-header-tabs");
    expect(html).toContain("> Chat</button>");
    expect(html).toContain("Fixture Taskset model");
    for (const label of ["Model", "Method", "Base model", "Runs", "Updated", "Status"]) expect(html).toContain(`<th>${label}</th>`);
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
    const [app, pane, workspace, diffPanel] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/components/app-shell/MainPane.tsx", "utf8"),
      readFile("apps/web/src/hooks/useWorkspaceController.ts", "utf8"),
      readFile("apps/web/src/components/workspace-diff/WorkspaceDiffPanel.tsx", "utf8"),
    ]);
    expect(app).toContain('view === "profile" || view === "training"');
    expect(app).toContain('if (view === "training")');
    expect(app).toContain('tab: "summary"');
    expect(app).toContain('showDiffControls: view === "chat" || view === "cloud" || view === "profile"');
    expect(pane).toContain("trainingTasksetRootPath");
    expect(pane).toContain("profiles/${bootstrap?.profile.activeProfile ?? \"default\"}/tasksets/${activeTrainingTasksetId}");
    expect(pane).toContain("fileRootPath={rightSidebarUsesSandbox ? null : trainingTasksetRootPath}");
    expect(pane).toContain("onOpenTasksetFiles={onShowFilesPanel}");
    expect(pane).toContain("trainingSummary={trainingSidebarSummary}");
    expect(diffPanel).toContain("TrainingRunSidebarSummary");
    expect(diffPanel).toContain("rootPath={fileRootPath}");
    expect(workspace).toContain('view === "training"');
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
    expect(view).toContain('setTab("models")');
    expect(view).toContain("onTasksetCreated={finishTasksetCreation}");
    expect(view).not.toContain('onTasksetCreated={() => finishRunSetup("tasksets")}');
  });

  test("shows primary and bootstrap stages without relabeling GRPO as local SFT", () => {
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
    const html = renderToStaticMarkup(createElement(TrainingStartDialog, { connection: null, taskset, destinations: [{ schemaVersion: "openpond.trainingDestinationCapabilities.v1", destinationId: "local_cpu_fixture", available: true, methods: ["sft"], parameterizations: ["lora"], modelAllowlist: [], maxDatasetBytes: null, environmentPlacements: ["local"], nonProduction: true, unavailableReason: null, checkedAt: "2026-07-13T00:00:00.000Z" }], busy: false, onClose: () => undefined, onStart: async () => true }));
    expect(html).toContain("Primary · GRPO");
    expect(html).toContain("Precursor · SFT trajectory bootstrap");
    expect(html).toContain("GRPO is the primary recommendation");
    expect(html).not.toContain("GRPO · LoRA");
  });

  test("keeps long New model recommendations scrollable", async () => {
    const css = await readFile("apps/web/src/styles/training/training.css", "utf8");
    expect(css).toContain(".training-run-workflow-step{height:min(680px,calc(100vh - 40px));overflow:hidden}");
    expect(css).toContain(".training-dialog-scroll-body{min-height:0;overflow:auto");
  });
});

function actionStubs() { return new Proxy({}, { get: () => async () => null }); }
