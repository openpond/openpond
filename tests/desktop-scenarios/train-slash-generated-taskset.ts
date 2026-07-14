import { readFile } from "node:fs/promises";
import path from "node:path";
import { TasksetSchema, type TaskCreationSnapshot } from "@openpond/contracts";
import { inspectTaskset } from "../../packages/taskset-sdk/src";
import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import { reloadRenderer, waitForRendererCondition } from "./helpers";
import {
  createTrainingChat,
  initializeTrainingProfile,
  openTrainingPage,
  registerTrainingModel,
  trainingState,
} from "./training-helpers";

const OBJECTIVE = "Train a model to reproduce the approved incident-review response.";

export default desktopScenario({
  name: "train-slash-generated-taskset",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    const model = await registerTrainingModel(harness, "slash-authoring");
    await initializeTrainingProfile(harness);
    const session = await createTrainingChat(
      harness,
      model,
      "Approved incident review",
      "Review this incident summary and return the approved response.",
    );
    const testSession = await createTrainingChat(
      harness,
      model,
      "Approved incident review follow-up",
      "Review this separate incident summary and return the approved response.",
    );

    await reloadRenderer(harness);
    await harness.renderer.assertText(session.title, { label: "source chat visible" });
    await harness.renderer.selectSession(session.id);
    await harness.renderer.submitComposer(`/train ${OBJECTIVE}`);
    await waitForRendererCondition(harness, `(() => {
      const row = [...document.querySelectorAll('.training-source-options label')].find((item) => item.textContent?.includes(${JSON.stringify(testSession.title)}));
      const checkbox = row?.querySelector('input[type=checkbox]');
      if (!(checkbox instanceof HTMLInputElement)) return false;
      if (!checkbox.checked) checkbox.click();
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Create training plan');
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`, "two-chat training selection");

    const disclosed = await waitForCreation(harness, (creation) =>
      creation.request.surface === "slash_train" && creation.request.objective === OBJECTIVE,
    );
    harness.recordAssertion("composerSlashPath", disclosed.request.surface === "slash_train");
    harness.recordAssertion("objectiveForwarded", disclosed.request.objective === OBJECTIVE);
    harness.recordAssertion("disclosureRequired", disclosed.state === "awaiting_disclosure_approval");

    const proposed = await harness.api.fetchJson<TaskCreationSnapshot>(
      `/v1/training/task-creations/${disclosed.id}/disclosure`,
      { method: "POST", body: { approved: true } },
    );
    if (proposed.state !== "awaiting_materialization_approval" || !proposed.proposal) {
      throw new Error(`Task Creator did not produce a reviewable proposal: ${proposed.state}`);
    }
    harness.recordAssertion("skillAuthoredProposal", proposed.proposal.generatedFiles.some((file) => file.path === "graders/approved-response.js"));
    harness.recordAssertion("graderProposed", proposed.proposal.proposedGraders.some((grader) => grader.kind === "custom_verifier"));

    const ready = await harness.api.fetchJson<TaskCreationSnapshot>(
      `/v1/training/task-creations/${disclosed.id}/materialize`,
      { method: "POST", body: { approved: true } },
    );
    if (!ready.materializedTasksetId) throw new Error(`Taskset materialization failed: ${ready.blockedReason ?? ready.state}`);

    const tasksetRoot = path.join(
      harness.artifactsDir,
      "profile-repo",
      "profiles",
      "default",
      "tasksets",
      ready.materializedTasksetId,
    );
    const tasksetPath = path.join(tasksetRoot, "taskset.json");
    const taskset = TasksetSchema.parse(JSON.parse(await readFile(tasksetPath, "utf8")));
    const verifier = await readFile(path.join(tasksetRoot, "graders", "approved-response.js"), "utf8");
    const inspection = await inspectTaskset(tasksetPath);
    harness.recordAssertion("tasksetValid", inspection.report.valid);
    harness.recordAssertion("generatedVerifierReadable", verifier.includes("export function verify") && verifier.includes("Approved response matched."));
    harness.recordAssertion("skillProvenanceRecorded", taskset.authoringProvenance.model?.modelId === model.modelId && taskset.authoringProvenance.skillHash.length >= 8);
    harness.recordAssertion("independentTrainAndTestSplits", taskset.tasks.some((task) => task.split === "train") && taskset.tasks.some((task) => task.split === "frozen_eval") && taskset.learningSignals.demonstrations.length > 0);

    const audit = await harness.api.fetchJson<{ report: { passed: boolean; hackingChecksPassed: boolean; leakageChecksPassed: boolean; infrastructureSafetyPassed: boolean } }>(
      "/v1/training/audit-graders",
      { method: "POST", body: { tasksetId: taskset.id } },
    );
    harness.recordAssertion("graderExecuted", audit.report.passed);
    harness.recordAssertion("graderSafetyPassed", audit.report.hackingChecksPassed && audit.report.leakageChecksPassed && audit.report.infrastructureSafetyPassed);
    harness.recordMetadata({ tasksetId: taskset.id, tasksetPath, verifierPath: path.join(tasksetRoot, "graders", "approved-response.js") });

    await openTrainingPage(harness);
    await harness.renderer.assertText(taskset.name, { label: "slash-authored Taskset visible" });
    await harness.screenshot("train-slash-generated-taskset");
  },
});

async function waitForCreation(
  harness: DesktopHarness,
  predicate: (creation: TaskCreationSnapshot) => boolean,
): Promise<TaskCreationSnapshot> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const state = await trainingState(harness);
    const creation = state.creations.find(predicate);
    if (creation) return creation;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the /train Task Creator state.");
}
