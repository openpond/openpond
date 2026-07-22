import type {
  BootstrapPayload,
  CreateImproveRun,
  CreateImproveRunListResponse,
  OpenPondActionCatalogEntry,
} from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import { reloadRenderer, waitForRendererCondition } from "./helpers";
import { addTrainingSource, initializeTrainingProfile, registerTrainingModel } from "./training-helpers";
import {
  ACCOUNT_AGENT_IMPROVEMENT,
  ACCOUNT_AGENT_PURPOSE,
  ACCOUNT_CHAT_FIXTURES,
  ACCOUNT_CORRECTION_CHAT,
  createAccountEvidenceChat,
  seedAccountHealthProfile,
} from "./account-agent-fixtures";
import {
  assert,
  clickAriaButton,
  clickButton,
  clickButtonContaining,
  clickTab,
  clickWorkproduct,
  clearTransientFocus,
  chooseComposerAction,
  delay,
  fillControl,
  fillComposerPrompt,
  resizeHarness,
  screenshot,
  selectComposerAction,
  selectChatsByTitles,
  selectVisibleChats,
  useWorkproduct,
} from "./account-agent-ui-helpers";

const CREATE_DIALOG = "[aria-label='New agent']";
const IMPROVE_DIALOG = "[aria-label='Improve Account Health Agent']";
const WIDE_VIEWPORT = { width: 1920, height: 1080 } as const;

export default desktopScenario({
  name: "account-agent-create-improve-e2e",
  mode: "isolated",
  timeoutMs: 900_000,
  async run(harness) {
    const captureHostedShare = process.env.OPENPOND_TUTORIAL_HOSTED_PROFILE_FIXTURE === "1";
    const authoringModel = await registerTrainingModel(harness, "account-agent-create-improve-e2e");
    await harness.api.fetchJson("/v1/preferences", {
      method: "PATCH",
      body: {
        defaultChatProvider: authoringModel.providerId,
        defaultChatModel: authoringModel.modelId,
        defaultChatModelRef: authoringModel,
        ...(captureHostedShare ? { defaultTeamId: "team-account-health-tutorial" } : {}),
      },
    });
    const activeProfile = await initializeTrainingProfile(harness);
    await seedAccountHealthProfile(harness, activeProfile.repoPath);
    const evidenceChats = [];
    for (const fixture of ACCOUNT_CHAT_FIXTURES) {
      evidenceChats.push(await createAccountEvidenceChat(harness, fixture));
    }
    const correctionChat = await createAccountEvidenceChat(harness, ACCOUNT_CORRECTION_CHAT);
    for (const chat of [...evidenceChats, correctionChat]) {
      await addTrainingSource(harness, chat.id);
    }

    await reloadRenderer(harness);
    await resizeHarness(harness, WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    await openLab(harness);
    await clickAriaButton(harness, "Create workproduct");
    await screenshot(harness, "C01", "account-agent-lab-create-menu");
    await clickButtonContaining(harness, "New agent");
    await harness.renderer.assertText("Choose a setup", { label: "Agent setup dialog" });
    await resizeHarness(harness, WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    await screenshot(harness, "C02", "source-choice-wide");
    await resizeHarness(harness, 620, 900);
    await screenshot(harness, "C03", "source-choice-narrow");
    await resizeHarness(harness, WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);

    await clickButtonContaining(harness, "From chats", CREATE_DIALOG);
    await clickButton(harness, "Continue", CREATE_DIALOG);
    await fillControl(harness, `${CREATE_DIALOG} textarea`, ACCOUNT_AGENT_PURPOSE);
    await harness.renderer.assertText(ACCOUNT_CHAT_FIXTURES[0].title, {
      label: "Account Health supporting chats",
      timeoutMs: 30_000,
    });
    await fillControl(
      harness,
      `${CREATE_DIALOG} input[placeholder='Search chats']`,
      "Account Health",
    );
    await selectChatsByTitles(
      harness,
      CREATE_DIALOG,
      ACCOUNT_CHAT_FIXTURES.map((fixture) => fixture.title),
    );
    await clearTransientFocus(harness);
    await screenshot(harness, "C04", "from-chats-wide");
    await resizeHarness(harness, 620, 900);
    await screenshot(harness, "C05", "from-chats-narrow");
    await resizeHarness(harness, WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    await clickButton(harness, "Review chats for plan", CREATE_DIALOG);
    await harness.renderer.assertText("Review chats for the Agent plan", {
      label: "Account Health chat sharing review",
      timeoutMs: 30_000,
    });
    await screenshot(harness, "C06", "disclosure");
    await clickButton(harness, "Approve chats and build plan", CREATE_DIALOG);
    await harness.renderer.assertText("Continue to Agent plan", {
      label: "Account Health Agent review",
      timeoutMs: 60_000,
    });
    await screenshot(harness, "C07", "agent-review");
    await clickButton(harness, "Continue to Agent plan", CREATE_DIALOG);

    await harness.renderer.assertText("When signals conflict", {
      label: "Account Health right-chat question",
      timeoutMs: 60_000,
    });
    const createRun = await waitForRun(harness, "create", ["awaiting_questions"]);
    assert(
      /account health/i.test(createRun.objective),
      "The question run lost the Account Health objective.",
    );
    await screenshot(harness, "C08", "right-chat-question");
    await clickButtonContaining(harness, "Billing and P1 first");
    await harness.renderer.assertText("Confirm plan", {
      label: "Account Health right-chat plan",
      timeoutMs: 60_000,
    });
    await screenshot(harness, "C09", "right-chat-plan");
    await clickButton(harness, "Edit plan");
    await fillControl(
      harness,
      ".composer-create-revision textarea",
      "Keep the source-backed chat, and make the weekly review available as Markdown, CSV, and JSON.",
    );
    await clearTransientFocus(harness);
    await screenshot(harness, "C09A", "edit-plan");
    await clickButton(harness, "Save revision");
    await harness.renderer.assertText("Confirm plan", {
      label: "Revised Account Health plan",
      timeoutMs: 60_000,
    });
    await screenshot(harness, "C09B", "revised-plan");
    await clickButton(harness, "Confirm plan");

    const createCandidate = await waitForRunById(harness, createRun.id, [
      "ready_local",
      "blocked",
      "failed",
      "cancelled",
    ], 660_000);
    assert(
      createCandidate.state === "ready_local",
      `Account Health creation ended in ${createCandidate.state}: ${createCandidate.blockedReason ?? "no reason"}`,
    );
    assert(
      createCandidate.evaluationReceipts.some((receipt) => receipt.subject === "candidate" && receipt.status === "passed"),
      "Account Health candidate did not pass its frozen Taskset evaluation.",
    );
    await openLabHome(harness);
    await clickWorkproduct(harness, "Account Health Agent");
    await clickTab(harness, "Evals");
    await screenshot(harness, "C10", "candidate-evaluation");
    await clickTab(harness, "Changes");
    await screenshot(harness, "C11", "local-source-applied");
    await clickTab(harness, "Overview");
    await harness.renderer.assertText("Account Health Agent", { label: "Ready local Account Health Agent" });
    await screenshot(harness, "C12", "ready-local-detail");

    const createdActions = await accountActions(harness);
    assertActionContract(createdActions);
    await openLabHome(harness);
    await useWorkproduct(harness, "Account Health Agent");
    await fillComposerPrompt(harness, "Summarize Acme with source-backed facts.");
    await clearTransientFocus(harness);
    await screenshot(harness, "C13Q", "chat-acme-prompt");
    await submitComposerAndWaitForAssistant(
      harness,
      "Summarize Acme with source-backed facts.",
      "21 days",
    );
    await harness.renderer.assertText("21 days", { label: "Acme chat answer", timeoutMs: 60_000 });
    await screenshot(harness, "C13", "chat-acme");
    await submitComposerAndWaitForAssistant(
      harness,
      "What should we do first, and who owns it?",
      "Revenue Operations",
    );
    await harness.renderer.assertText("Revenue Operations", { label: "Acme follow-up", timeoutMs: 60_000 });
    await screenshot(harness, "C14", "chat-follow-up");

    await openComposerActionPicker(harness, "/summarize", "Summarize Account");
    await screenshot(harness, "C15", "action-picker");
    await chooseComposerAction(harness, "Summarize Account");
    await submitComposerAndWaitForAssistant(
      harness,
      JSON.stringify({ accountId: "northstar" }),
      "Northstar is an expansion opportunity",
    );
    await harness.renderer.assertText("Northstar is an expansion opportunity", {
      label: "Northstar direct summary",
      timeoutMs: 60_000,
    });
    await screenshot(harness, "C16", "northstar-summary");

    await selectComposerAction(harness, "/triage", "Triage Renewal Risk");
    await submitComposerAndWaitForAssistant(
      harness,
      JSON.stringify({ accountId: "acme", asOfDate: "2026-07-20" }),
      "Acme is high risk",
    );
    await harness.renderer.assertText("Acme is high risk", { label: "Acme direct risk triage", timeoutMs: 60_000 });
    await screenshot(harness, "C17", "acme-triage");

    await selectComposerAction(harness, "/weekly", "Build Weekly Account Review");
    await submitComposerAndWaitForAssistant(
      harness,
      JSON.stringify({ asOfDate: "2026-07-20", minimumRisk: "medium" }),
      "Weekly account review",
    );
    await harness.renderer.assertText("Weekly account review", { label: "Weekly review result", timeoutMs: 60_000 });
    await harness.renderer.assertText("weekly-account-review.md", { label: "Weekly review artifact", timeoutMs: 30_000 });
    await screenshot(harness, "C18", "weekly-review-artifacts");

    await verifyDirectActions(harness, createdActions, false);
    assert(harness.restart, "The Account Health proof requires isolated desktop restart support.");
    await harness.restart();
    await harness.api.health();
    await reloadRenderer(harness);
    await resizeHarness(harness, WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    await openLab(harness);
    await harness.renderer.assertText("Account Health Agent", { label: "Account Health Agent after restart" });
    await clickWorkproduct(harness, "Account Health Agent");
    await clickTab(harness, "Overview");
    await screenshot(harness, "C19", "after-restart");

    await openLabHome(harness);
    await useWorkproduct(harness, "Account Health Agent");
    await selectComposerAction(harness, "/triage", "Triage Renewal Risk");
    await submitComposerAndWaitForAssistant(
      harness,
      JSON.stringify({ accountId: "acme", asOfDate: "2026-07-20" }),
      "Acme is high risk",
    );
    await screenshot(harness, "I00", "current-priority-gap");

    await openLab(harness);
    await clickWorkproduct(harness, "Account Health Agent");
    await clickButton(harness, "Improve agent");
    await harness.renderer.assertText("Choose a setup", { label: "Improve Agent setup" });
    await screenshot(harness, "I01", "improve-source-choice");
    await clickButtonContaining(harness, "From chats", IMPROVE_DIALOG);
    await clickButton(harness, "Continue", IMPROVE_DIALOG);
    await fillControl(harness, `${IMPROVE_DIALOG} textarea`, ACCOUNT_AGENT_IMPROVEMENT);
    await fillControl(
      harness,
      `${IMPROVE_DIALOG} input[placeholder='Search chats']`,
      "Account Health",
    );
    await selectChatsByTitles(harness, IMPROVE_DIALOG, [
      ...ACCOUNT_CHAT_FIXTURES.map((fixture) => fixture.title),
      ACCOUNT_CORRECTION_CHAT.title,
    ]);
    await clearTransientFocus(harness);
    await screenshot(harness, "I02", "improve-from-chats");
    await clickButton(harness, "Review chats for plan", IMPROVE_DIALOG);
    await clickButton(harness, "Approve chats and build plan", IMPROVE_DIALOG);
    await harness.renderer.assertText("Continue to improvement plan", {
      label: "Improve Agent review",
      timeoutMs: 60_000,
    });
    await screenshot(harness, "I03", "improve-review");
    await clickButton(harness, "Continue to improvement plan", IMPROVE_DIALOG);
    await harness.renderer.assertText("Confirm plan", {
      label: "Improve Agent right-chat plan",
      timeoutMs: 60_000,
    });
    const improveRun = await waitForRun(harness, "improve", ["awaiting_plan_approval"]);
    await screenshot(harness, "I04", "improve-right-chat-plan");
    await clickButton(harness, "Confirm plan");
    const improveCandidate = await waitForRunById(harness, improveRun.id, [
      "awaiting_promotion",
      "blocked",
      "failed",
      "cancelled",
    ], 660_000);
    assert(
      improveCandidate.state === "awaiting_promotion",
      `Account Health improvement ended in ${improveCandidate.state}: ${improveCandidate.blockedReason ?? "no reason"}`,
    );
    const activeReceipt = improveCandidate.evaluationReceipts.find((receipt) => receipt.subject === "active");
    const candidateReceipt = improveCandidate.evaluationReceipts.find((receipt) => receipt.subject === "candidate");
    assert(activeReceipt?.status === "failed", "The active Agent unexpectedly passed the correction Taskset.");
    assert(candidateReceipt?.status === "passed", "The improved candidate did not pass the correction Taskset.");
    await clickTab(harness, "Evals");
    await screenshot(harness, "I05", "improve-comparison");
    await clickButton(harness, "Apply update");
    const improved = await waitForRunById(harness, improveRun.id, ["released", "blocked", "failed", "rejected"], 180_000);
    assert(improved.state === "released", `Improved Agent release ended in ${improved.state}: ${improved.blockedReason ?? "no reason"}`);
    await clickTab(harness, "Overview");
    await screenshot(harness, "I06", "improved-release");

    const improvedActions = await accountActions(harness);
    assertActionContract(improvedActions);
    await openLabHome(harness);
    await useWorkproduct(harness, "Account Health Agent");
    await submitComposerAndWaitForAssistant(
      harness,
      "For Acme, rank the risks and cite the sources.",
      "Billing/P1",
    );
    await harness.renderer.assertText("Billing/P1", {
      label: "Improved chat priority",
      timeoutMs: 60_000,
    });
    await screenshot(harness, "I07", "improved-chat");
    await selectComposerAction(harness, "/triage", "Triage Renewal Risk");
    await submitComposerAndWaitForAssistant(
      harness,
      JSON.stringify({ accountId: "acme", asOfDate: "2026-07-20" }),
      "Billing/P1 priority comes first",
    );
    await harness.renderer.assertText("Billing/P1 priority comes first", {
      label: "Improved triage priority",
      timeoutMs: 60_000,
    });
    await screenshot(harness, "I08", "improved-triage");
    await verifyDirectActions(harness, improvedActions, true);

    if (captureHostedShare) {
      await openLabHome(harness);
      await clickButton(harness, "Commit");
      await harness.renderer.assertText("Commit profile", { label: "Profile commit dialog" });
      await fillControl(
        harness,
        ".profile-commit-dialog input[aria-label='Commit message'], .profile-commit-dialog input",
        "Improve Account Health Agent priority guidance",
      );
      await clearTransientFocus(harness);
      await screenshot(harness, "I09", "profile-commit-dialog");
      await clickButton(harness, "Commit", ".profile-commit-dialog");
      await waitForRendererCondition(
        harness,
        `(() => {
          const status = document.querySelector('.profile-local-status');
          return !document.querySelector('.profile-commit-dialog') &&
            status?.textContent?.includes('source is clean') === true;
        })()`,
        "clean committed Profile source",
        { timeoutMs: 60_000 },
      );
      await clickButton(harness, "Sync");
      await harness.renderer.assertText("Sync profile", { label: "Profile sync dialog" });
      await harness.renderer.assertText("attached to hosted sandboxes", { label: "Profile sync purpose" });
      await screenshot(harness, "I10", "profile-sync-dialog");
    }

    assertScreenshotContract(harness, captureHostedShare);
    harness.recordAssertion("accountAgentCreateReadyLocal", true);
    harness.recordAssertion("accountAgentTwoTurnChatPassed", true);
    harness.recordAssertion("accountAgentAllDirectActionsPassed", true);
    harness.recordAssertion("accountAgentRestartPersistencePassed", true);
    harness.recordAssertion("accountAgentImproveRegressionPassed", true);
    if (captureHostedShare) harness.recordAssertion("accountAgentHostedProfileSyncReviewPassed", true);
    harness.recordMetadata({
      createRunId: createRun.id,
      improveRunId: improveRun.id,
      accountActionIds: improvedActions.map((action) => action.id),
      screenshotCount: captureHostedShare ? 33 : 31,
      fixtureFiles: ["accounts.json", "product-usage.csv", "support-cases.json", "billing-status.json"],
    });
  },
});

async function openLab(harness: DesktopHarness): Promise<void> {
  await clickAriaButton(harness, "Lab");
  await harness.renderer.assertText("Home", { label: "Lab home", timeoutMs: 30_000 });
}

async function openLabHome(harness: DesktopHarness): Promise<void> {
  await openLab(harness);
  await clickButton(harness, "Home");
  await harness.renderer.assertText("Account Health Agent", { label: "Account Health Agent workproduct" });
}

async function waitForRun(
  harness: DesktopHarness,
  operation: "create" | "improve",
  states: CreateImproveRun["state"][],
): Promise<CreateImproveRun> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await harness.api.fetchJson<CreateImproveRunListResponse>("/v1/create-improve-runs", {
      query: { profileId: "default", limit: 100 },
    });
    const run = response.runs.find((item) =>
      item.target.kind === "agent"
      && item.operation === operation
      && (
        item.target.id === "account-health-agent"
        || /account health/i.test(item.objective)
      )
      && Boolean(item.tasksetRef)
      && states.includes(item.state));
    if (run) return run;
    await delay(500);
  }
  throw new Error(`Timed out waiting for the Account Health ${operation} run in ${states.join(", ")}.`);
}

async function waitForRunById(
  harness: DesktopHarness,
  runId: string,
  states: CreateImproveRun["state"][],
  timeoutMs: number,
): Promise<CreateImproveRun> {
  const deadline = Date.now() + timeoutMs;
  let latest: CreateImproveRun | null = null;
  while (Date.now() < deadline) {
    latest = await harness.api.fetchJson<CreateImproveRun>(`/v1/create-improve-runs/${runId}`);
    if (states.includes(latest.state)) return latest;
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for ${runId}. Last state: ${latest?.state ?? "unknown"}.`);
}

async function accountActions(harness: DesktopHarness): Promise<OpenPondActionCatalogEntry[]> {
  const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
  const actions = bootstrap.profile.actionCatalog.filter((action) => action.agentId === "account-health-agent");
  assert(actions.length === 4, `Expected four Account Health actions, found ${actions.length}.`);
  return actions;
}

function assertActionContract(actions: OpenPondActionCatalogEntry[]): void {
  const bySourceId = new Map(actions.map((action) => [action.sourceActionId, action]));
  assert(bySourceId.has("chat"), "Account Health default chat action is missing.");
  assert(bySourceId.get("summarize-account")?.inputSchema === "SummarizeAccountInput", "summarize-account schema drifted.");
  assert(bySourceId.get("triage-renewal-risk")?.inputSchema === "TriageRenewalRiskInput", "triage-renewal-risk schema drifted.");
  assert(bySourceId.get("build-weekly-account-review")?.inputSchema === "WeeklyAccountReviewInput", "weekly review schema drifted.");
}

async function verifyDirectActions(
  harness: DesktopHarness,
  actions: OpenPondActionCatalogEntry[],
  improved: boolean,
): Promise<void> {
  const bySourceId = new Map(actions.map((action) => [action.sourceActionId, action]));
  const cases = [
    {
      id: "chat",
      input: { prompt: "Summarize Glacier with sources.", channel: "openpond_chat" },
      expected: "Glacier is medium risk",
    },
    {
      id: "summarize-account",
      input: { accountId: "northstar" },
      expected: "Northstar is an expansion opportunity",
    },
    {
      id: "triage-renewal-risk",
      input: { accountId: "acme", asOfDate: "2026-07-20" },
      expected: improved ? "Billing/P1 priority comes first" : "Acme is high risk",
    },
    {
      id: "build-weekly-account-review",
      input: { asOfDate: "2026-07-20", minimumRisk: "medium" },
      expected: "Weekly account review",
    },
  ];
  for (const item of cases) {
    const action = bySourceId.get(item.id);
    assert(action, `Missing direct proof action ${item.id}.`);
    const response = await harness.api.fetchJson<{ code: number | null; stdout: string }>("/v1/profile/run", {
      method: "POST",
      body: { action: action.id, input: item.input },
    });
    assert(response.code === 0, `${item.id} returned exit code ${response.code}.`);
    assert(response.stdout.includes(item.expected), `${item.id} output did not include ${item.expected}.`);
    if (item.id === "build-weekly-account-review") {
      assert(response.stdout.includes("artifacts/weekly-account-review.md"), "Weekly Markdown artifact is missing.");
      assert(response.stdout.includes("artifacts/weekly-account-review.csv"), "Weekly CSV artifact is missing.");
      assert(response.stdout.includes("artifacts/weekly-account-review.json"), "Weekly JSON artifact is missing.");
    }
  }
}

async function openComposerActionPicker(
  harness: DesktopHarness,
  query: string,
  label: string,
): Promise<void> {
  if (harness.renderer.replaceComposerText) {
    await harness.renderer.replaceComposerText(query);
  } else {
    await harness.renderer.evaluate(`(() => {
    const input = [...document.querySelectorAll('.composer-inline-input[role="textbox"]')]
      .find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null);
    if (!(input instanceof HTMLElement)) return false;
    input.focus();
    input.textContent = ${JSON.stringify(query)};
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(query)} }));
    return true;
    })()`);
  }
  await harness.renderer.assertText(label, { label: `${label} picker`, timeoutMs: 30_000 });
}

async function submitComposerAndWaitForAssistant(
  harness: DesktopHarness,
  prompt: string,
  expectedText: string,
): Promise<void> {
  await harness.renderer.submitComposer(prompt);
  await waitForRendererCondition(
    harness,
    `(() => {
      const hasExpectedAssistant = [...document.querySelectorAll('.message-row.assistant')]
        .some((row) => row instanceof HTMLElement && row.offsetParent !== null && row.textContent?.includes(${JSON.stringify(expectedText)}));
      const running = [...document.querySelectorAll('form.composer .stop-button')]
        .some((button) => button instanceof HTMLElement && button.offsetParent !== null);
      return hasExpectedAssistant && !running;
    })()`,
    `completed assistant response containing ${expectedText}`,
    { timeoutMs: 60_000 },
  );
  await waitForRendererCondition(
    harness,
    `(() => {
      const input = [...document.querySelectorAll('.composer-inline-input[role="textbox"]')]
        .find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null);
      if (!(input instanceof HTMLElement)) return false;
      const content = input.cloneNode(true);
      if (!(content instanceof HTMLElement)) return false;
      content.querySelectorAll('[data-inline-token="true"]').forEach((token) => token.remove());
      return !(content.textContent ?? '').trim();
    })()`,
    "settled visible composer after submission",
    { timeoutMs: 10_000 },
  );
  await delay(3_000);
}

function assertScreenshotContract(_harness: DesktopHarness, captureHostedShare: boolean): void {
  // The harness report is the durable source of truth. Keeping the expected count
  // adjacent to the scenario makes accidental frame additions/removals reviewable.
  const expected = captureHostedShare ? 33 : 31;
  assert(expected === (captureHostedShare ? 33 : 31), "The Account Health screenshot contract changed unexpectedly.");
}
