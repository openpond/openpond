import type {
  BootstrapPayload,
  CreateImproveRun,
  CreateImproveRunListResponse,
} from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import {
  addTrainingSource,
  createTrainingChat,
  initializeTrainingProfile,
  registerTrainingModel,
} from "./training-helpers";
import { reloadRenderer, waitForRendererCondition } from "./helpers";

const OBJECTIVE = "Change the default Agent so every chat returns exactly `scripted turn 1 response for: ${prompt.slice(0, 80)}`, where prompt is the incoming prompt.";

export default desktopScenario({
  name: "lab-new-agent-ui",
  mode: "isolated",
  timeoutMs: 720_000,
  async run(harness) {
    const authoringModel = await registerTrainingModel(harness, "lab-new-agent-ui");
    await initializeTrainingProfile(harness);
    const chats = await Promise.all([
      createTrainingChat(
        harness,
        authoringModel,
        "Approved deterministic Agent behavior A",
        "Summarize the billing retry change.",
      ),
      createTrainingChat(
        harness,
        authoringModel,
        "Approved deterministic Agent behavior B",
        "Summarize the search ranking change.",
      ),
    ]);
    await Promise.all(chats.map((chat) => addTrainingSource(harness, chat.id)));
    await reloadRenderer(harness);
    await openLab(harness);
    await clickWorkproduct(harness, "default");
    await clickByAriaLabel(harness, "Improve agent");
    await harness.renderer.assertText("Choose a setup", {
      label: "Improve Agent shared authoring shell",
    });
    await clickButtonContainingText(harness, "From chats", "[aria-label='Improve default']");
    await clickButtonByText(harness, "Continue", "[aria-label='Improve default']");
    await fillTextarea(harness, "[aria-label='Improve default'] textarea", OBJECTIVE);
    await harness.renderer.assertText("Approved deterministic Agent behavior A", {
      label: "Improve Agent evidence",
      timeoutMs: 30_000,
    });
    await fillTextInput(
      harness,
      "[aria-label='Improve default'] input[placeholder='Search chats']",
      "Approved deterministic Agent behavior",
    );
    await harness.renderer.assertText("Showing 2 of 2 matching chats", {
      label: "filtered Improve Agent evidence",
      timeoutMs: 30_000,
    });
    await clickButtonByText(harness, "Select visible", "[aria-label='Improve default']");
    await waitForRendererCondition(
      harness,
      `document.querySelectorAll("[aria-label='Improve default'] input[type='checkbox']:checked").length >= 2`,
      "selected Improve Agent evidence",
    );
    await clickButtonByText(harness, "Review selected chats", "[aria-label='Improve default']");
    await harness.renderer.assertText("Review chats before sharing", {
      label: "Improve Agent chat sharing review",
      timeoutMs: 30_000,
    });
    await clickButtonByText(harness, "Approve chats and build plan", "[aria-label='Improve default']");
    await harness.renderer.assertText("Continue to improvement plan", {
      label: "Improve Agent review",
      timeoutMs: 60_000,
    });
    await clickButtonByText(harness, "Continue to improvement plan", "[aria-label='Improve default']");
    await clickTab(harness, "Changes");
    await clickButtonContainingText(harness, OBJECTIVE, ".labs-agent-change-history");
    await harness.renderer.assertText("Confirm plan", {
      label: "Lab Agent plan review",
      timeoutMs: 60_000,
    });

    const planned = await latestLabAgentRun(harness);
    assert(planned.state === "awaiting_plan_approval", `Agent run reached ${planned.state} instead of plan review.`);
    assert(planned.tasksetRef, "Agent improvement did not retain the approved common Taskset ref.");
    assert(planned.evidenceSnapshots.length > 0, "Agent improvement did not retain immutable evidence snapshots.");
    assert(planned.scope.conversationId, "Lab Agent run is missing its hidden execution session.");
    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const executionSession = bootstrap.sessions.find((session) => session.id === planned.scope.conversationId);
    assert(executionSession?.systemKind === "openpond.lab", "Agent execution did not use the Lab system session.");
    assert(executionSession.hiddenFromDefaultSidebar, "Lab Agent execution session is visible in the normal sidebar.");
    const sidebarContainsExecutionChat = await harness.renderer.evaluate<boolean>(
      `document.body.innerText.includes(${JSON.stringify(executionSession.title)})`,
    );
    assert(!sidebarContainsExecutionChat, "The hidden Lab execution session leaked into the visible UI.");

    await clickButtonByText(harness, "Confirm plan");
    const candidate = await waitForAgentCandidate(harness, planned.id);
    assert(
      candidate.state === "awaiting_promotion",
      `Agent candidate ended in ${candidate.state}: ${candidate.blockedReason ?? "no failure reason"}`,
    );
    assert(candidate.candidates.some((item) => item.status === "evaluated"), "No evaluated Agent candidate was produced.");
    const activeReceipt = candidate.evaluationReceipts.find((receipt) => receipt.subject === "active");
    const candidateReceipt = candidate.evaluationReceipts.find((receipt) => receipt.subject === "candidate");
    assert(activeReceipt?.status === "failed", "The known-bad active Agent unexpectedly passed the correction Taskset.");
    assert(candidateReceipt?.status === "passed", "The authored Agent candidate did not pass the correction Taskset.");
    assert(activeReceipt.tasksetHash === planned.tasksetRef.contentHash, "Active evaluation used another Taskset hash.");
    assert(candidateReceipt.tasksetHash === planned.tasksetRef.contentHash, "Candidate evaluation used another Taskset hash.");
    assert(
      activeReceipt.metadata.executionContractHash === candidateReceipt.metadata.executionContractHash,
      "Active and candidate evaluation did not use the same execution contract.",
    );
    await harness.renderer.assertText("Apply update", {
      label: "Agent promotion decision",
      timeoutMs: 30_000,
    });
    await clickButtonByText(harness, "Apply update");
    const released = await waitForAgentRelease(harness, planned.id);
    assert(released.state === "released", `Agent release ended in ${released.state}: ${released.blockedReason ?? "no failure reason"}`);
    const postRelease = released.evaluationReceipts.find((receipt) => receipt.subject === "post_release");
    assert(postRelease?.status === "passed", "The merged Agent did not pass post-release Taskset evaluation.");
    assert(postRelease.tasksetHash === planned.tasksetRef.contentHash, "Post-release evaluation used another Taskset hash.");
    assert(
      released.evidenceSnapshots.some((snapshot) => snapshot.metadata.evidenceKind === "candidate_outcome"),
      "Released candidate outcome was not appended as evidence for the next Taskset revision.",
    );
    await harness.renderer.assertText("Merged", {
      label: "released Agent change in Lab",
      timeoutMs: 30_000,
    });

    harness.recordAssertion("labAgentCreatedWithoutVisibleChat", true);
    harness.recordAssertion("labAgentPlanReviewedInLab", true);
    harness.recordAssertion("labAgentCandidateEvaluated", true);
    harness.recordAssertion("labAgentCorrectionMergedLocally", true);
    harness.recordAssertion("labAgentPostReleaseTasksetPassed", true);
    harness.recordMetadata({
      runId: candidate.id,
      targetAgentId: candidate.target.id,
      executionSessionId: candidate.scope.conversationId,
      state: released.state,
      tasksetId: planned.tasksetRef.id,
      tasksetRevision: planned.tasksetRef.revision,
      tasksetHash: planned.tasksetRef.contentHash,
      candidateIds: released.candidates.map((item) => item.id),
      postReleaseReceiptId: postRelease.id,
    });
    await harness.screenshot("lab-agent-correction-released");
  },
});

async function openLab(harness: DesktopHarness): Promise<void> {
  await clickByAriaLabel(harness, "Lab");
  await harness.renderer.assertText("Home", { label: "Lab home" });
}

async function clickTab(harness: DesktopHarness, text: string): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const button = [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent?.trim().startsWith(${JSON.stringify(text)}));
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    `${text} tab`,
  );
}

async function latestLabAgentRun(harness: DesktopHarness): Promise<CreateImproveRun> {
  const response = await harness.api.fetchJson<CreateImproveRunListResponse>(
    "/v1/create-improve-runs",
    { query: { profileId: "default", limit: 100 } },
  );
  const run = response.runs.find((item) =>
    item.target.kind === "agent" &&
    item.target.id === "default" &&
    item.operation === "improve" &&
    Boolean(item.tasksetRef),
  );
  if (!run) throw new Error("The Lab UI did not persist an Agent Create/Improve run.");
  return run;
}

async function waitForAgentRelease(
  harness: DesktopHarness,
  runId: string,
): Promise<CreateImproveRun> {
  const deadline = Date.now() + 180_000;
  let latest: CreateImproveRun | null = null;
  while (Date.now() < deadline) {
    latest = await harness.api.fetchJson<CreateImproveRun>(`/v1/create-improve-runs/${runId}`);
    if (["released", "blocked", "failed", "rejected"].includes(latest.state)) return latest;
    await delay(500);
  }
  throw new Error(`Timed out waiting for Agent release. Last state: ${latest?.state ?? "unknown"}.`);
}

async function clickWorkproduct(harness: DesktopHarness, name: string): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const row = [...document.querySelectorAll('tbody tr')].find((candidate) =>
        [...candidate.querySelectorAll('*')].some((item) =>
          item.children.length === 0 && item.textContent?.trim() === ${JSON.stringify(name)}));
      if (!(row instanceof HTMLTableRowElement)) return false;
      row.click();
      return true;
    })()`,
    `${name} workproduct`,
  );
}

async function waitForAgentCandidate(
  harness: DesktopHarness,
  runId: string,
): Promise<CreateImproveRun> {
  const deadline = Date.now() + 600_000;
  let latest: CreateImproveRun | null = null;
  while (Date.now() < deadline) {
    latest = await harness.api.fetchJson<CreateImproveRun>(`/v1/create-improve-runs/${runId}`);
    if (["awaiting_promotion", "blocked", "failed", "cancelled"].includes(latest.state)) return latest;
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for Agent candidate. Last state: ${latest?.state ?? "unknown"}.`);
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
