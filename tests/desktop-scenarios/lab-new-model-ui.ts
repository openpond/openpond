import type {
  CreateImproveRun,
  Taskset,
  TrainingJob,
  TrainingStateResponse,
} from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import { reloadRenderer, waitForRendererCondition } from "./helpers";
import {
  addTrainingSource,
  createTrainingChat,
  initializeTrainingProfile,
  registerTrainingModel,
  trainingState,
} from "./training-helpers";

const OBJECTIVE = "Draft concise release notes from an approved change summary.";

export default desktopScenario({
  name: "lab-new-model-ui",
  mode: "isolated",
  timeoutMs: 720_000,
  async run(harness) {
    const evidenceTitle = `T0 shared Taskset proof ${Date.now()}`;
    const authoringModel = await registerTrainingModel(harness, "lab-new-model-ui");
    await initializeTrainingProfile(harness);
    const chats = await Promise.all([
      "billing retry change",
      "search ranking change",
      "workspace access change",
      "provider routing change",
    ].map((change) => createTrainingChat(
      harness,
      authoringModel,
      evidenceTitle,
      `Draft release notes for the ${change}.`,
    )));
    await Promise.all(chats.map((chat) => addTrainingSource(harness, chat.id)));

    await reloadRenderer(harness);
    await openLab(harness);
    harness.recordAssertion("labOpened", true);
    await clickByAriaLabel(harness, "Create");
    harness.recordAssertion("createMenuOpened", true);
    await clickButtonContainingText(harness, "Model");
    await harness.renderer.assertText("How do you want to start?", {
      label: "New Model start step",
    });
    harness.recordAssertion("newModelDialogOpened", true);
    await clickButtonContainingText(harness, "Manual", "[aria-label='New model']");
    await clickButtonByText(harness, "Continue", "[aria-label='New model']");
    await fillTextarea(harness, "[aria-label='New model'] textarea", OBJECTIVE);
    harness.recordAssertion("manualObjectiveEntered", true);
    await harness.renderer.assertText(evidenceTitle, {
      label: "New Model evidence",
      timeoutMs: 30_000,
    });
    await fillTextInput(
      harness,
      "[aria-label='New model'] input[placeholder='Search chats']",
      evidenceTitle,
    );
    await harness.renderer.assertText("Showing 4 of 4 matching chats", {
      label: "filtered New Model evidence",
      timeoutMs: 30_000,
    });
    await clickButtonByText(harness, "Select visible", "[aria-label='New model']");
    await waitForRendererCondition(
      harness,
      `document.querySelectorAll("[aria-label='New model'] input[type='checkbox']:checked").length >= 2`,
      "selected New Model evidence",
    );
    await clickButtonByText(harness, "Review data access", "[aria-label='New model']");
    harness.recordAssertion("evidenceSelected", true);
    await harness.renderer.assertText("Approve evidence disclosure", {
      label: "New Model disclosure",
      timeoutMs: 30_000,
    });
    await clickButtonByText(harness, "Approve and analyze", "[aria-label='New model']");
    harness.recordAssertion("disclosureApproved", true);
    await harness.renderer.assertText("Create model", {
      label: "New Model recommendation",
      timeoutMs: 60_000,
    });
    await clickButtonByText(harness, "Create model", "[aria-label='New model']");
    harness.recordAssertion("tasksetMaterializationApproved", true);

    const taskset = await waitForTaskset(harness);
    assert(taskset.sourceRefs.length === chats.length, "The UI-created Taskset did not retain both selected chats.");
    const manualRun = await waitForTasksetRun(harness, taskset);
    assert(manualRun.target.kind === "model", "Manual New Model did not retain the Model target.");
    assert(manualRun.tasksetRef?.id === taskset.id, "Manual New Model run did not consume the common Taskset ref.");
    assert(manualRun.tasksetRef.contentHash === taskset.contentHash, "Manual New Model run silently replaced the approved Taskset hash.");
    await harness.renderer.assertText(taskset.name, {
      label: "Model workproduct detail",
      timeoutMs: 30_000,
    });
    harness.recordAssertion("modelWorkproductOpened", true);

    await clickTab(harness, "Dataset");
    await harness.renderer.assertText("Examples", { label: "Model Dataset examples" });
    await harness.renderer.assertText(evidenceTitle, { label: "Model evidence lineage" });
    harness.recordAssertion("modelDataLineageVisible", true);

    await clickTab(harness, "Evals");
    await clickButtonByText(harness, "Run Evals");
    const readyTaskset = await waitForReadyTaskset(harness, taskset.id);
    assert(readyTaskset.readiness?.ready, "The Lab Evals action did not make the Taskset training-ready.");
    harness.recordAssertion("evalsCompleted", true);

    await clickTab(harness, "Training");
    await clickButtonByText(harness, "Start training", ".training-detail-sections");
    await harness.renderer.assertText("Training data", {
      label: "Training start dialog",
      timeoutMs: 30_000,
    });
    await clickButtonByText(harness, "Start training", "[role='dialog']");
    harness.recordAssertion("trainingLaunchApproved", true);
    const { job, state } = await waitForTrainingCompletion(harness, taskset.id);
    const model = state.models.find((item) => item.jobId === job.id);
    assert(job.status === "succeeded", `The UI-started training job ended as ${job.status}: ${job.error ?? "no error"}`);
    assert(model?.status === "imported", "The UI-started training job did not register an imported model.");
    const trainedRun = await waitForTasksetRun(harness, taskset);
    assert(trainedRun.id === manualRun.id, "Training created a second Model run instead of continuing the authoring run.");
    assert(trainedRun.target.kind === "model" && trainedRun.target.trainingJobId === job.id, "The Model target did not retain the UI-launched training job.");
    assert(
      trainedRun.candidates.some((candidate) => candidate.artifactRefs.includes(model.artifactId)),
      "The imported Model artifact was not represented as the run candidate.",
    );

    await harness.renderer.assertText("Chat", {
      label: "Trained model Chat action",
      timeoutMs: 30_000,
    });
    await harness.renderer.assertText("Model comparison", {
      label: "Model comparison surface",
      timeoutMs: 30_000,
    });
    await harness.renderer.assertText("Promotion & bindings", {
      label: "Model promotion surface",
    });
    await harness.renderer.assertText("Promotion gate", {
      label: "Model promotion gate",
    });
    await waitForRendererCondition(
      harness,
      `(() => {
        const button = [...document.querySelectorAll("button")].find(
          (item) => item.textContent?.trim() === "Bind model",
        );
        return button instanceof HTMLButtonElement && button.disabled;
      })()`,
      "failed frozen evaluation blocks Model binding",
    );
    harness.recordAssertion("modelComparisonVisible", true);
    harness.recordAssertion("modelPromotionGateVisible", true);
    harness.recordAssertion("failedEvaluationBlocksBinding", true);
    await harness.renderer.evaluate(`(() => {
      const heading = [...document.querySelectorAll("h2")].find(
        (item) => item.textContent?.trim() === "Promotion & bindings",
      );
      heading?.scrollIntoView({ block: "center" });
      return Boolean(heading);
    })()`);
    await harness.screenshot("lab-new-model-ui-promotion-gate");
    await clickTab(harness, "Versions");
    await waitForRendererCondition(
      harness,
      `(() => {
        const facts = new Map(
          [...document.querySelectorAll(".labs-inline-facts > div")].map((item) => [
            item.querySelector("dt")?.textContent?.trim(),
            item.querySelector("dd")?.textContent?.trim(),
          ]),
        );
        return facts.get("Candidates") === "1" && facts.get("Model artifacts") === "1";
      })()`,
      "Model Versions lineage",
    );
    harness.recordAssertion("modelVersionsLineageVisible", true);
    await harness.screenshot("lab-new-model-ui-manual-trained");

    await clickButtonByText(harness, "Models", ".titlebar-breadcrumbs");
    await harness.renderer.assertText(taskset.name, {
      label: "Trained model in workproducts",
      timeoutMs: 30_000,
    });

    await clickByAriaLabel(harness, "Create");
    await clickButtonContainingText(harness, "Model");
    await clickButtonContainingText(harness, "Automatic", "[aria-label='New model']");
    await clickButtonByText(harness, "Continue", "[aria-label='New model']");
    await harness.renderer.assertText("Find repeated work", {
      label: "Automated New Model scan scope",
    });
    await clickButtonByText(harness, "Scan chats", "[aria-label='New model']");
    await harness.renderer.assertText("Review repeated workflows", {
      label: "Automated New Model candidates",
      timeoutMs: 60_000,
    });
    await clickButtonContainingText(harness, evidenceTitle, "[aria-label='New model']");
    await clickButtonByText(harness, "Review data access", "[aria-label='New model']");
    await harness.renderer.assertText("Approve evidence disclosure", {
      label: "Automated New Model disclosure",
      timeoutMs: 30_000,
    });
    await clickButtonByText(harness, "Approve and analyze", "[aria-label='New model']");
    await harness.renderer.assertText("Create model", {
      label: "Automated New Model recommendation",
      timeoutMs: 60_000,
    });
    await clickButtonByText(harness, "Create model", "[aria-label='New model']");
    const automatedTaskset = await waitForTaskset(harness, new Set([taskset.id]));
    assert(automatedTaskset.sourceRefs.length === chats.length, "Automated New Model lost the repeated-work evidence cluster.");
    const automatedRun = await waitForTasksetRun(harness, automatedTaskset);
    assert(automatedRun.id !== manualRun.id, "Automated and Manual authoring unexpectedly reused one run.");
    assert(automatedRun.target.kind === "model", "Automated New Model did not retain the Model target.");
    assert(automatedRun.tasksetRef?.id === automatedTaskset.id, "Automated New Model did not consume common Taskset lineage.");
    assert(automatedRun.tasksetRef.contentHash === automatedTaskset.contentHash, "Automated New Model changed the approved Taskset revision.");
    harness.recordAssertion("automatedModelCreatedThroughSharedShell", true);

    harness.recordAssertion("labModelCreatedFromSelectedChats", true);
    harness.recordAssertion("labModelEvalsRunFromUi", true);
    harness.recordAssertion("labModelTrainingStartedFromUi", true);
    harness.recordAssertion("trainedModelVisibleInWorkproducts", true);
    harness.recordMetadata({
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      createImproveRunId: manualRun.id,
      automatedTasksetId: automatedTaskset.id,
      automatedTasksetHash: automatedTaskset.contentHash,
      automatedCreateImproveRunId: automatedRun.id,
      sourceSessionIds: chats.map((chat) => chat.id),
      jobId: job.id,
      modelId: model.id,
      modelStatus: model.status,
    });
    await harness.screenshot("lab-new-model-ui-automated-ready");
  },
});

async function openLab(harness: DesktopHarness): Promise<void> {
  await clickByAriaLabel(harness, "Lab");
  await harness.renderer.assertText("Home", { label: "Lab home" });
}

async function waitForTaskset(
  harness: DesktopHarness,
  excludedIds: ReadonlySet<string> = new Set(),
): Promise<Taskset> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await trainingState(harness);
    const taskset = state.tasksets.find((candidate) => !excludedIds.has(candidate.id));
    if (taskset) return taskset;
    await delay(250);
  }
  throw new Error("Timed out waiting for the UI-created Taskset.");
}

async function waitForTasksetRun(
  harness: DesktopHarness,
  taskset: Taskset,
): Promise<CreateImproveRun> {
  assert(taskset.createImproveRunId, `Taskset ${taskset.id} has no common Create/Improve run lineage.`);
  const deadline = Date.now() + 30_000;
  let latest: CreateImproveRun | null = null;
  while (Date.now() < deadline) {
    latest = await harness.api.fetchJson<CreateImproveRun>(
      `/v1/create-improve-runs/${taskset.createImproveRunId}`,
    );
    if (
      latest.tasksetRef?.id === taskset.id
      && latest.tasksetRef.revision === taskset.revision
      && latest.tasksetRef.contentHash === taskset.contentHash
    ) {
      return latest;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for common Taskset lineage ${taskset.id}@${taskset.revision} (${taskset.contentHash}); ` +
    `last run ref was ${latest?.tasksetRef?.id ?? "null"}@${latest?.tasksetRef?.revision ?? "null"} ` +
    `(${latest?.tasksetRef?.contentHash ?? "null"}).`,
  );
}

async function waitForReadyTaskset(
  harness: DesktopHarness,
  tasksetId: string,
): Promise<Taskset> {
  const deadline = Date.now() + 90_000;
  let latest: Taskset | null = null;
  while (Date.now() < deadline) {
    const state = await trainingState(harness);
    latest = state.tasksets.find((item) => item.id === tasksetId) ?? null;
    if (latest?.readiness?.ready) return latest;
    await delay(500);
  }
  throw new Error(
    `Timed out waiting for Eval readiness: ${latest?.readiness?.blockers.map((item) => item.code).join(", ") ?? "missing Taskset"}.`,
  );
}

async function waitForTrainingCompletion(
  harness: DesktopHarness,
  tasksetId: string,
): Promise<{ job: TrainingJob; state: TrainingStateResponse }> {
  const deadline = Date.now() + 240_000;
  let latest: TrainingJob | null = null;
  while (Date.now() < deadline) {
    const state = await trainingState(harness);
    const planIds = new Set(
      state.plans
        .filter((plan) => plan.tasksetId === tasksetId)
        .map((plan) => plan.id),
    );
    latest = state.jobs
      .filter((item) => planIds.has(item.planId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
    if (latest && ["succeeded", "failed", "cancelled"].includes(latest.status)) {
      return { job: latest, state };
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for model training. Last state: ${latest?.status ?? "not started"}.`);
}

async function clickTab(harness: DesktopHarness, text: string): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const button = [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent?.trim() === ${JSON.stringify(text)});
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    `${text} tab`,
  );
}

async function clickByAriaLabel(harness: DesktopHarness, label: string): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const button = document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)});
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    `${label} button`,
  );
}

async function clickButtonByText(
  harness: DesktopHarness,
  text: string,
  rootSelector = "body",
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const root = document.querySelector(${JSON.stringify(rootSelector)});
      if (!root) return false;
      const button = [...root.querySelectorAll("button")].find((item) => item.textContent?.trim() === ${JSON.stringify(text)});
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    `${text} button`,
  );
}

async function clickButtonContainingText(
  harness: DesktopHarness,
  text: string,
  rootSelector = "body",
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const root = document.querySelector(${JSON.stringify(rootSelector)});
      if (!root) return false;
      const label = [...root.querySelectorAll("strong, span, h1, h2, h3")].find((item) => item.textContent?.trim() === ${JSON.stringify(text)});
      const button = label?.closest("button");
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    `${text} button`,
  );
}

async function fillTextarea(
  harness: DesktopHarness,
  selector: string,
  value: string,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const field = document.querySelector(${JSON.stringify(selector)});
      if (!(field instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return field.value === ${JSON.stringify(value)};
    })()`,
    `${selector} value`,
  );
}

async function fillTextInput(
  harness: DesktopHarness,
  selector: string,
  value: string,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const field = document.querySelector(${JSON.stringify(selector)});
      if (!(field instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return field.value === ${JSON.stringify(value)};
    })()`,
    `${selector} value`,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
