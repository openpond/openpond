import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BootstrapPayload, RuntimeEvent, Session } from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import {
  asRecord,
  configureCodingSubagentModel,
  expandChildSessionGroup,
  registerScriptedOpenPondModel,
  reloadRenderer,
  stringFromRecord,
  toolResultFromEvent,
  waitForCompletedTurn,
  waitForRendererCondition,
  waitForSidebarSessionRow,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-subagent-blocker",
};

const blockerSnippet = "copy_on_write isolation unavailable";

export default desktopScenario({
  name: "subagent-blocked-approval",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    await configureCodingSubagentModel(harness, modelRef);

    const blockedWorkspace = await mkdtemp(path.join(tmpdir(), "openpond-harness-blocked-subagent-"));

    const title = harness.uniqueTitle("subagent-blocked-approval");
    const session = await harness.api.createSession<Session>({
      provider: "openpond",
      modelRef,
      title,
      cwd: blockedWorkspace,
    });

    await reloadRenderer(harness);
    harness.recordMetadata({
      parentSessionId: session.id,
      title,
      modelRef,
      blockedWorkspace,
    });
    await harness.renderer.selectSession(session.id);
    await harness.renderer.assertText(title, { label: "blocked parent session title" });

    await harness.renderer.submitComposer("Start the scripted coding subagent and show the blocker if isolation is unavailable.");
    const startEvent = await harness.events.waitForToolCompleted(
      session.id,
      "openpond_subagent_start",
    ) as RuntimeEvent;
    const startResult = toolResultFromEvent(startEvent);
    const runId = stringFromRecord(startResult, "runId");
    const childSessionId = stringFromRecord(startResult, "childSessionId");
    const startStatus = stringFromRecord(startResult, "status");
    if (!runId) throw new Error("openpond_subagent_start did not return a runId.");
    if (!childSessionId) throw new Error("openpond_subagent_start did not return a childSessionId.");
    if (startStatus !== "blocked") {
      throw new Error(`Expected openpond_subagent_start to return blocked status, received ${startStatus ?? "none"}.`);
    }

    const blockedEvent = await harness.events.waitFor(
      (event) => {
        if (event.sessionId !== session.id || event.name !== "subagent.blocked") return false;
        const run = asRecord(asRecord(event.data)?.run);
        return stringFromRecord(run, "id") === runId && stringFromRecord(run, "status") === "blocked";
      },
      `subagent.blocked:${runId}`,
      { sessionId: session.id },
    ) as RuntimeEvent;
    await waitForCompletedTurn(harness, session.id, startEvent, "blocked parent turn completion");

    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const blockedRun = asRecord(asRecord(blockedEvent.data)?.run);
    const childSession = bootstrap.sessions.find((item) => item.id === childSessionId);
    if (!childSession) throw new Error(`Child session ${childSessionId} was not present in bootstrap.`);
    if (childSession.parentSessionId !== session.id) {
      throw new Error(`Child session ${childSessionId} was not linked to parent ${session.id}.`);
    }
    if (bootstrap.events.some((event) =>
      event.sessionId === session.id &&
      event.name === "subagent.completed" &&
      stringFromRecord(asRecord(asRecord(event.data)?.run), "id") === runId
    )) {
      throw new Error(`Blocked subagent ${runId} also emitted subagent.completed.`);
    }
    const pendingApprovals = bootstrap.approvals.filter((approval) =>
      approval.sessionId === session.id &&
      approval.status === "pending"
    );
    if (pendingApprovals.length !== 0) {
      throw new Error(`Expected no pending approvals for isolation blocker, found ${pendingApprovals.length}.`);
    }

    await harness.renderer.assertText("Subagent blocked", { label: "blocked activity summary" });
    await expandBlockedActivityDetails(harness);
    await harness.renderer.assertText(blockerSnippet, { label: "blocked isolation detail" });
    await harness.renderer.assertText(`Coding subagent blocked for ${runId}.`, {
      label: "blocked parent assistant response",
    });
    harness.recordAssertion("subagentBlockedActivityVisible", true);
    harness.recordAssertion("isolationBlockerVisible", true);
    harness.recordAssertion("blockedRunDidNotComplete", true);
    harness.recordAssertion("noPendingApprovalCreated", true);
    await harness.screenshot("subagent-blocked-approval-parent");

    await expandChildSessionGroup(harness, session.id);
    await waitForSidebarSessionRow(harness, childSession.id, { timeoutMs: 10_000 });
    harness.recordAssertion("blockedChildSidebarRowVisible", true);
    harness.recordMetadata({
      runId,
      childSessionId,
      parentTurnId: startEvent.turnId ?? null,
      blocker: stringFromRecord(blockedRun, "error"),
      runtimeEventCount: bootstrap.events.filter((event) => event.sessionId === session.id).length,
    });

    await harness.screenshot("subagent-blocked-approval-complete");
  },
});

async function expandBlockedActivityDetails(harness: DesktopHarness): Promise<void> {
  const blocker = JSON.stringify(blockerSnippet);
  await waitForRendererCondition(
    harness,
    `(() => {
      const detailRows = Array.from(document.querySelectorAll('.activity-detail-row'));
      const detail = detailRows.find((candidate) =>
        candidate.textContent?.includes('Subagent blocked') &&
        candidate.textContent?.includes(${blocker})
      );
      if (detail) return true;
      const buttons = Array.from(document.querySelectorAll('.activity-summary'));
      const button = buttons.find((candidate) =>
        candidate.textContent?.toLowerCase().includes('subagent blocked')
      );
      if (!(button instanceof HTMLButtonElement)) return false;
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
      return false;
    })()`,
    "expanded blocked subagent activity details",
    { timeoutMs: 10_000 },
  );
}
