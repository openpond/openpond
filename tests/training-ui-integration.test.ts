import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { TrainingView } from "../apps/web/src/components/training/TrainingView";
import { TrainingTasksetDetail } from "../apps/web/src/components/training/TrainingTasksetDetail";
import { sourceFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("Training UI", () => {
  test("centers training around Models and Tasksets", () => {
    const taskset = tasksetFixture();
    const controller = { payload: { schemaVersion: "openpond.trainingState.v1", profileId: "default", sources: [sourceFixture()], creations: [], tasksets: [taskset], baselineReports: [], candidates: [], minerConfig: { schemaVersion: "openpond.taskMinerConfig.v1", enabled: false, localOnly: true, observationWindowDays: 30, minimumRecurrence: 3, clustering: "hybrid_deterministic_first", consentRequired: true }, plans: [], bundles: [], jobs: [], artifacts: [], models: [], destinations: [], credentialRefs: [], generatedAt: "2026-07-12T00:00:00Z" }, loading: false, busyAction: null, error: null, refresh: async () => null, actions: actionStubs() } as any;
    const html = renderToStaticMarkup(createElement(TrainingView, { training: controller, sessions: [], connection: null, defaultModel: { providerId: "custom-openai-compatible", modelId: "fixture" }, onError: () => undefined, onSettingsPreferences: () => undefined, onOpenChat: () => undefined, selectedTasksetId: null, onSelectedTasksetIdChange: () => undefined, launchRequest: null, onLaunchHandled: () => undefined, preferences: { defaultModelRef: null, creationMode: "customize", autoApproveEvidence: false }, settingsPreferences: {} as any, providerSettings: null, reasoningEffort: "high" }));
    for (const label of ["Models", "Tasksets", "New model", "Settings"]) expect(html).toContain(label);
    expect(html).not.toContain('>Experiments<');
    expect(html).not.toContain('>Suggestions<');
    expect(html).not.toContain('>Runs<');
    expect(html).toContain('aria-selected="true" class="active">Models');
    expect(html).not.toContain("Tasksets &amp; runs");
    for (const removed of ["Task Creator", "Create with defaults", "Customize", "Add chats"]) expect(html).not.toContain(removed);
    expect(html).toContain("training-model-steps");
    for (const label of ["Training setup", "Training", "Evaluation", "Result", "Open Taskset"]) expect(html).toContain(label);
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
    for (const label of ["Method", "SFT", "Training examples", "Evaluation examples", "Evaluation", "Expected output match", "2 chats"]) expect(html).toContain(label);
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
    expect(app).toContain('tab: "files"');
    expect(app).toContain('showDiffControls: view === "chat" || view === "cloud" || view === "profile"');
    expect(pane).toContain("trainingTasksetRootPath");
    expect(pane).toContain("profiles/${bootstrap?.profile.activeProfile ?? \"default\"}/tasksets/${activeTrainingTasksetId}");
    expect(pane).toContain("fileRootPath={rightSidebarUsesSandbox ? null : trainingTasksetRootPath}");
    expect(diffPanel).toContain("rootPath={fileRootPath}");
    expect(workspace).toContain('view === "training"');
  });
});

function actionStubs() { return new Proxy({}, { get: () => async () => null }); }
